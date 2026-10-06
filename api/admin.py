"""Identity (/me), company cache, role assignments, audit log."""

from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import Depends
from pydantic import BaseModel, Field

from nttdsp.web import Conflict, Forbidden, Invalid, NotFound, SecuredRouter, db, secured

from access import COMPANY_ADMIN, GLOBAL_ADMIN, Access, as_json, audit, get_access

router = SecuredRouter()


class CompanyIn(BaseModel):
    id: UUID
    name: str = Field(..., min_length=1, max_length=200)
    code: str = Field("", max_length=120)


class RoleAssignmentIn(BaseModel):
    user_id: UUID
    user_name: str = Field("", max_length=200)
    user_email: str = Field("", max_length=320)
    role: Literal["global_admin", "company_admin", "requester"]
    company_id: UUID | None = None


@router.get("/me")
@secured(requires=["user:any"], db_access="read")
async def me(conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)) -> dict[str, Any]:
    """Identity + roles for the SPA (menus, scope pickers). Open to any
    authenticated user so the SPA can show a "no access" page cleanly."""
    ids = list(acc.member_companies)
    companies = await conn.fetch(
        "SELECT id, name FROM companies WHERE id = ANY($1::uuid[]) ORDER BY name", ids
    ) if ids else []
    return {
        "user_id": acc.user_id,
        "user_name": acc.user_name,
        "is_global_admin": acc.is_global_admin,
        "is_admin": acc.is_any_admin,
        "has_access": acc.has_any_role,
        "companies": [
            {"id": c["id"], "name": c["name"],
             "role": COMPANY_ADMIN if c["id"] in acc.admin_companies else "requester"}
            for c in companies
        ],
    }


@router.get("/companies")
@secured(requires=["permission:member"], db_access="read")
async def list_companies(
    conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> list[dict[str, Any]]:
    if acc.is_global_admin:
        rows = await conn.fetch("SELECT id, name, code FROM companies ORDER BY name")
    else:
        rows = await conn.fetch(
            "SELECT id, name, code FROM companies WHERE id = ANY($1::uuid[]) ORDER BY name",
            list(acc.member_companies),
        )
    return [dict(r) for r in rows]


@router.post("/companies")
@secured(requires=["permission:global_admin"], db_access="write")
async def upsert_company(
    body: CompanyIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    """Called by the SPA after a global admin picks a company from the
    Digital Fabric directory. Refreshes the cached display name."""
    row = await conn.fetchrow(
        "INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code, updated_at = now() "
        "RETURNING id, name, code",
        body.id, body.name, body.code,
    )
    return dict(row)


@router.get("/role-assignments")
@secured(requires=["permission:admin"], db_access="read")
async def list_role_assignments(
    conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> list[dict[str, Any]]:
    sql = ("SELECT r.id, r.user_id, r.user_name, r.user_email, r.role, r.company_id, co.name AS company_name, "
           "r.created_at FROM role_assignments r LEFT JOIN companies co ON co.id = r.company_id")
    if acc.is_global_admin:
        rows = await conn.fetch(f"{sql} ORDER BY r.role, co.name NULLS FIRST, r.user_name")
    else:
        rows = await conn.fetch(
            f"{sql} WHERE r.company_id = ANY($1::uuid[]) ORDER BY co.name, r.user_name",
            list(acc.admin_companies),
        )
    return [dict(r) for r in rows]


def _ensure_can_grant(acc: Access, role: str, company_id: UUID | None) -> None:
    if role == GLOBAL_ADMIN:
        if company_id is not None:
            raise Invalid("global admin is not tied to a company")
        if not acc.is_global_admin:
            raise Forbidden("only a global admin can grant global admin")
        return
    if company_id is None:
        raise Invalid("company is required for this role")
    if not acc.can_manage(company_id):
        raise Forbidden("you are not an admin for this company")


@router.post("/role-assignments", status_code=201)
@secured(requires=["permission:admin"], db_access="write")
async def create_role_assignment(
    body: RoleAssignmentIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    _ensure_can_grant(acc, body.role, body.company_id)
    if body.company_id and not await conn.fetchval("SELECT 1 FROM companies WHERE id = $1", body.company_id):
        raise Invalid("unknown company; pick it from the directory first")
    new_id = await conn.fetchval(
        "INSERT INTO role_assignments (user_id, user_name, user_email, role, company_id, created_by) "
        "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id",
        body.user_id, body.user_name, body.user_email, body.role, body.company_id, acc.user_id,
    )
    if new_id is None:
        raise Conflict("this user already has that role")
    await audit(conn, acc, entity_type="role_assignment", entity_id=new_id, action="grant",
                company_id=body.company_id, summary=f"{body.user_name or body.user_id}: {body.role}")
    return {"id": new_id}


@router.delete("/role-assignments/{assignment_id}", status_code=204)
@secured(requires=["permission:admin"], db_access="write")
async def delete_role_assignment(
    assignment_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> None:
    row = await conn.fetchrow(
        "SELECT user_id, user_name, role, company_id FROM role_assignments WHERE id = $1", assignment_id
    )
    if row is None:
        raise NotFound("role assignment not found")
    _ensure_can_grant(acc, row["role"], row["company_id"])
    if row["role"] == GLOBAL_ADMIN:
        n = await conn.fetchval("SELECT count(*) FROM role_assignments WHERE role = 'global_admin'")
        if n <= 1:
            raise Conflict("cannot remove the last global admin")
    await conn.execute("DELETE FROM role_assignments WHERE id = $1", assignment_id)
    await audit(conn, acc, entity_type="role_assignment", entity_id=assignment_id, action="revoke",
                company_id=row["company_id"], summary=f"{row['user_name'] or row['user_id']}: {row['role']}")


@router.get("/audit-events")
@secured(requires=["permission:admin"], db_access="read")
async def list_audit_events(
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    company_id: UUID | None = None,
    limit: int = 200,
    conn: asyncpg.Connection = Depends(db),
    acc: Access = Depends(get_access),
) -> list[dict[str, Any]]:
    # Static SQL; NULL filter params mean "no filter". Global admins see
    # everything, company admins only their companies' events.
    rows = await conn.fetch(
        "SELECT a.id, a.entity_type, a.entity_id, a.action, a.company_id, co.name AS company_name, a.summary, "
        "a.diff, a.user_name, a.user_id, a.real_user_id, a.user_impersonation, a.created_at "
        "FROM audit_events a LEFT JOIN companies co ON co.id = a.company_id "
        "WHERE ($1::bool OR a.company_id = ANY($2::uuid[])) "
        "AND ($3::text IS NULL OR a.entity_type = $3) "
        "AND ($4::uuid IS NULL OR a.entity_id = $4) "
        "AND ($5::uuid IS NULL OR a.company_id = $5) "
        "ORDER BY a.created_at DESC LIMIT $6",
        acc.is_global_admin, list(acc.admin_companies), entity_type, entity_id, company_id,
        max(1, min(limit, 1000)),
    )
    return [{**dict(r), "diff": as_json(r["diff"])} for r in rows]
