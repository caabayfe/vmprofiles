"""Access model for vm-profiles.

Who can do what is kept in the app's own `role_assignments` table, keyed by
the Digital Fabric user_id from the DSP-Token (see yarp_guide_get("groups"):
"keep the cohort in your own database keyed by user_id").

Roles:
  global_admin   -> everything, every company, global rows included
  company_admin  -> manage rows owned by their company, approve its requests
  requester      -> read profiles for their company, submit requests

Endpoint gates use `requires=["permission:member" | "permission:admin" |
"permission:global_admin"]`; row-level company checks happen in the
handlers through the `Access` object.
"""

import json
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import Depends

from nttdsp.web import Actor, Forbidden, Invalid, access_resolver, current_actor, db

GLOBAL_ADMIN = "global_admin"
COMPANY_ADMIN = "company_admin"
REQUESTER = "requester"


@dataclass
class Access:
    user_id: UUID
    real_user_id: UUID
    user_name: str
    is_global_admin: bool = False
    admin_companies: set[UUID] = field(default_factory=set)
    requester_companies: set[UUID] = field(default_factory=set)

    @property
    def member_companies(self) -> set[UUID]:
        return self.admin_companies | self.requester_companies

    @property
    def has_any_role(self) -> bool:
        return self.is_global_admin or bool(self.member_companies)

    @property
    def is_any_admin(self) -> bool:
        return self.is_global_admin or bool(self.admin_companies)

    @property
    def impersonating(self) -> bool:
        return self.user_id != self.real_user_id

    def can_view(self, company_id: UUID | None) -> bool:
        if self.is_global_admin or company_id is None:
            return self.has_any_role
        return company_id in self.member_companies

    def can_manage(self, company_id: UUID | None) -> bool:
        if self.is_global_admin:
            return True
        return company_id is not None and company_id in self.admin_companies

    def can_request(self, company_id: UUID) -> bool:
        return self.is_global_admin or company_id in self.member_companies

    def can_approve(self, company_id: UUID) -> bool:
        return self.is_global_admin or company_id in self.admin_companies

    def ensure_view(self, company_id: UUID | None) -> None:
        if not self.can_view(company_id):
            raise Forbidden("not visible for your companies")

    def ensure_manage(self, company_id: UUID | None) -> None:
        if not self.can_manage(company_id):
            if company_id is None:
                raise Forbidden("only a global admin can change global items")
            raise Forbidden("you are not an admin for this company")


def _uuid(value: Any) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))


async def load_access(conn: asyncpg.Connection, actor: Actor) -> Access:
    user_id = _uuid(actor.user_id)
    real = getattr(actor, "real_user_id", None) or actor.user_id
    acc = Access(user_id=user_id, real_user_id=_uuid(real), user_name=getattr(actor, "name", "") or "")
    rows = await conn.fetch(
        "SELECT role, company_id FROM role_assignments WHERE user_id = $1", user_id
    )
    for r in rows:
        if r["role"] == GLOBAL_ADMIN:
            acc.is_global_admin = True
        elif r["role"] == COMPANY_ADMIN:
            acc.admin_companies.add(r["company_id"])
        elif r["role"] == REQUESTER:
            acc.requester_companies.add(r["company_id"])
    return acc


async def get_access(
    conn: asyncpg.Connection = Depends(db),
    actor: Actor = Depends(current_actor),
) -> Access:
    return await load_access(conn, actor)


@access_resolver("permission")
async def permission_resolver(
    conn: asyncpg.Connection, actor: Actor, values: list[str], params: dict
) -> bool:
    acc = await load_access(conn, actor)
    for value in values:
        name = value.split(":", 1)[-1]
        if name == "member" and acc.has_any_role:
            return True
        if name == "admin" and acc.is_any_admin:
            return True
        if name == "global_admin" and acc.is_global_admin:
            return True
    return False


# ---------------------------------------------------------------------------
# Scope helpers shared by every module
# ---------------------------------------------------------------------------

def parse_scope(scope: str | None) -> str | UUID:
    """'all' (default) | 'global' | <company uuid>."""
    if scope in (None, "", "all"):
        return "all"
    if scope == "global":
        return "global"
    try:
        return UUID(scope)
    except ValueError as exc:
        raise Invalid("scope must be 'all', 'global' or a company id") from exc


def visibility_sql(
    acc: Access, owner_expr: str, scope: str | UUID, args: list[Any], *, effective: bool = False
) -> str:
    """SQL predicate restricting rows to what `acc` may see and what `scope` asks for.

    `owner_expr` is a code-defined SQL expression (never user input) that
    yields the owning company_id (NULL = global). Appends bind values to
    `args` and returns the predicate text.
    """
    parts: list[str] = []
    if not acc.is_global_admin:
        args.append(list(acc.member_companies))
        parts.append(f"({owner_expr} IS NULL OR {owner_expr} = ANY(${len(args)}::uuid[]))")
    if scope == "global":
        parts.append(f"{owner_expr} IS NULL")
    elif isinstance(scope, UUID):
        args.append(scope)
        if effective:
            parts.append(f"({owner_expr} IS NULL OR {owner_expr} = ${len(args)})")
        else:
            parts.append(f"{owner_expr} = ${len(args)}")
    return " AND ".join(parts) if parts else "TRUE"


def ensure_ref_scope(target: UUID | None, ref: UUID | None, what: str) -> None:
    """A global row may only reference global rows; a company row may
    reference global rows or rows from the same company."""
    if ref is None:
        return
    if target is None:
        raise Invalid(f"a global profile can only use global {what}")
    if ref != target:
        raise Invalid(f"{what} belongs to a different company")


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def as_json(value: Any) -> Any:
    """jsonb comes back as text unless the pool registered a codec."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


async def audit(
    conn: asyncpg.Connection,
    acc: Access,
    *,
    entity_type: str,
    entity_id: UUID | None,
    action: str,
    company_id: UUID | None = None,
    summary: str = "",
    diff: dict | None = None,
) -> None:
    await conn.execute(
        "INSERT INTO audit_events (entity_type, entity_id, action, company_id, summary, diff, "
        "user_id, user_name, real_user_id, user_impersonation) "
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)",
        entity_type,
        entity_id,
        action,
        company_id,
        summary[:500],
        json.dumps(diff or {}, default=str),
        acc.user_id,
        acc.user_name,
        acc.real_user_id,
        acc.impersonating,
    )
