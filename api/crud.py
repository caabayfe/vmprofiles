"""Generic, scope-aware CRUD for the simple catalog and infrastructure tables.

Each `Resource` describes one table. `register(router, resource)` adds:

  GET    {path}                 list (visibility + scope + parent filters)
  POST   {path}                 create
  PUT    {path}/{id}            update (immutable columns ignored)
  POST   {path}/{id}/archive    soft delete (is_active = false)
  POST   {path}/{id}/restore    undo archive
  DELETE {path}/{id}            hard delete; 409 "archive instead" when referenced

Ownership ("which company owns this row?") depends on the table:
  company      -> the row's own company_id column
  global_only  -> always global (only a global admin may write)
  vcenter      -> the company_id of the row's vCenter
  datacenter   -> via datacenter -> vCenter
  cluster      -> via cluster -> vCenter

All table/column names come from the code-defined Resource specs below,
never from user input, so the f-string SQL here is allowlisted by design.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg
from asyncpg.exceptions import (
    CheckViolationError,
    ForeignKeyViolationError,
    UniqueViolationError,
)
from fastapi import Depends, Request
from pydantic import BaseModel

from nttdsp.web import Conflict, Invalid, NotFound, SecuredRouter, db, secured

from access import Access, audit, get_access, parse_scope, visibility_sql

OWNER_SQL = {
    "company": "t.company_id",
    "global_only": "NULL::uuid",
    "vcenter": "(SELECT v.company_id FROM vcenters v WHERE v.id = t.vcenter_id)",
    "datacenter": (
        "(SELECT v.company_id FROM datacenters d JOIN vcenters v ON v.id = d.vcenter_id "
        "WHERE d.id = t.datacenter_id)"
    ),
    "cluster": (
        "(SELECT v.company_id FROM clusters c JOIN vcenters v ON v.id = c.vcenter_id "
        "WHERE c.id = t.cluster_id)"
    ),
}

# How to find the owning company from a create payload, per ownership kind.
PARENT_OWNER_SQL = {
    "vcenter": ("vcenter_id", "SELECT company_id FROM vcenters WHERE id = $1"),
    "datacenter": (
        "datacenter_id",
        "SELECT v.company_id FROM datacenters d JOIN vcenters v ON v.id = d.vcenter_id WHERE d.id = $1",
    ),
    "cluster": (
        "cluster_id",
        "SELECT v.company_id FROM clusters c JOIN vcenters v ON v.id = c.vcenter_id WHERE c.id = $1",
    ),
}

Hook = Callable[[asyncpg.Connection, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class Resource:
    path: str
    table: str
    entity: str
    model: type[BaseModel]
    columns: list[str]
    ownership: str
    immutable: list[str] = field(default_factory=list)
    filters: list[str] = field(default_factory=list)
    # Query-param filters on a derived value: name -> SQL expression over `t`.
    derived_filters: dict[str, str] = field(default_factory=dict)
    extra_select: list[str] = field(default_factory=list)
    order_by: str = "t.name"
    label_column: str = "name"
    has_audit_columns: bool = False
    before_create: Hook | None = None
    # When any of these is set on create/update, stamp capacity_updated_at.
    capacity_columns: list[str] = field(default_factory=list)


def db_errors(exc: Exception) -> Exception:
    if isinstance(exc, UniqueViolationError):
        return Conflict("an item with the same name already exists here")
    if isinstance(exc, ForeignKeyViolationError):
        return Conflict(
            "this item is referenced by other items (or references a missing one); "
            "archive it instead of deleting"
        )
    if isinstance(exc, CheckViolationError):
        return Invalid("a value is outside the allowed range")
    return exc


async def owner_of_row(conn: asyncpg.Connection, res: Resource, row_id: UUID) -> tuple[bool, UUID | None]:
    row = await conn.fetchrow(
        f"SELECT {OWNER_SQL[res.ownership]} AS owner FROM {res.table} t WHERE t.id = $1", row_id  # noqa: S608
    )
    if row is None:
        raise NotFound(f"{res.entity} not found")
    return True, row["owner"]


async def owner_for_create(conn: asyncpg.Connection, res: Resource, data: dict[str, Any]) -> UUID | None:
    if res.ownership == "company":
        return data.get("company_id")
    if res.ownership == "global_only":
        return None
    col, sql = PARENT_OWNER_SQL[res.ownership]
    row = await conn.fetchrow(sql, data[col])
    if row is None:
        raise Invalid(f"{col} does not exist")
    return row["company_id"]


def register(router: SecuredRouter, res: Resource) -> None:
    owner = OWNER_SQL[res.ownership]
    stamp = ["capacity_updated_at"] if res.capacity_columns else []
    select_cols = ", ".join(f"t.{c}" for c in ["id", *res.columns, *stamp, "is_active", "created_at"])
    extras = "".join(f", {e}" for e in res.extra_select)
    base_select = (
        f"SELECT {select_cols}, {owner} AS owner_company_id, "  # noqa: S608
        f"(SELECT co.name FROM companies co WHERE co.id = {owner}) AS owner_company_name{extras} "
        f"FROM {res.table} t"
    )
    model = res.model
    name = res.table

    async def fetch_one(conn: asyncpg.Connection, row_id: UUID) -> dict[str, Any]:
        row = await conn.fetchrow(f"{base_select} WHERE t.id = $1", row_id)
        if row is None:
            raise NotFound(f"{res.entity} not found")
        return dict(row)

    @router.get(res.path, name=f"list_{name}")
    @secured(requires=["permission:member"], db_access="read")
    async def list_items(
        request: Request,
        scope: str | None = None,
        include_archived: bool = False,
        conn: asyncpg.Connection = Depends(db),
        acc: Access = Depends(get_access),
    ) -> list[dict[str, Any]]:
        args: list[Any] = []
        where = [visibility_sql(acc, owner, parse_scope(scope), args)]
        if not include_archived:
            where.append("t.is_active")
        filter_exprs = {f: f"t.{f}" for f in res.filters} | res.derived_filters
        for f, expr in filter_exprs.items():
            value = request.query_params.get(f)
            if value:
                try:
                    args.append(UUID(value))
                except ValueError as exc:
                    raise Invalid(f"{f} must be a UUID") from exc
                where.append(f"{expr} = ${len(args)}")
        rows = await conn.fetch(
            f"{base_select} WHERE {' AND '.join(where)} ORDER BY {res.order_by}", *args
        )
        return [dict(r) for r in rows]

    @router.post(res.path, status_code=201, name=f"create_{name}")
    @secured(requires=["permission:admin"], db_access="write")
    async def create_item(
        body: model,  # type: ignore[valid-type]
        conn: asyncpg.Connection = Depends(db),
        acc: Access = Depends(get_access),
    ) -> dict[str, Any]:
        data = body.model_dump()
        company = await owner_for_create(conn, res, data)
        acc.ensure_manage(company)
        if res.before_create:
            data = await res.before_create(conn, data)
        cols = [c for c in res.columns if c in data]
        if res.has_audit_columns:
            cols.append("created_by")
            data["created_by"] = acc.user_id
        if any(data.get(c) is not None for c in res.capacity_columns):
            cols.append("capacity_updated_at")
            data["capacity_updated_at"] = datetime.now(UTC)
        placeholders = ", ".join(f"${i}" for i in range(1, len(cols) + 1))
        try:
            new_id = await conn.fetchval(
                f"INSERT INTO {res.table} ({', '.join(cols)}) VALUES ({placeholders}) RETURNING id",  # noqa: S608
                *[data[c] for c in cols],
            )
        except (UniqueViolationError, ForeignKeyViolationError, CheckViolationError) as exc:
            raise db_errors(exc) from exc
        await audit(conn, acc, entity_type=res.entity, entity_id=new_id, action="create",
                    company_id=company, summary=str(data.get(res.label_column, "")), diff=data)
        return await fetch_one(conn, new_id)

    @router.put(f"{res.path}/{{item_id}}", name=f"update_{name}")
    @secured(requires=["permission:admin"], db_access="write")
    async def update_item(
        item_id: UUID,
        body: model,  # type: ignore[valid-type]
        conn: asyncpg.Connection = Depends(db),
        acc: Access = Depends(get_access),
    ) -> dict[str, Any]:
        _, company = await owner_of_row(conn, res, item_id)
        acc.ensure_manage(company)
        data = body.model_dump()
        cols = [c for c in res.columns if c in data and c not in res.immutable]
        sets = [f"{c} = ${i}" for i, c in enumerate(cols, start=2)]
        values = [data[c] for c in cols]
        if res.has_audit_columns:
            values.append(acc.user_id)
            sets.append(f"updated_by = ${len(values) + 1}")
            sets.append("updated_at = now()")
        if any(data.get(c) is not None for c in res.capacity_columns):
            sets.append("capacity_updated_at = now()")
        try:
            await conn.execute(
                f"UPDATE {res.table} SET {', '.join(sets)} WHERE id = $1", item_id, *values  # noqa: S608
            )
        except (UniqueViolationError, ForeignKeyViolationError, CheckViolationError) as exc:
            raise db_errors(exc) from exc
        await audit(conn, acc, entity_type=res.entity, entity_id=item_id, action="update",
                    company_id=company, summary=str(data.get(res.label_column, "")),
                    diff={c: data[c] for c in cols})
        return await fetch_one(conn, item_id)

    async def _set_active(conn: asyncpg.Connection, acc: Access, item_id: UUID, active: bool) -> dict[str, Any]:
        _, company = await owner_of_row(conn, res, item_id)
        acc.ensure_manage(company)
        await conn.execute(f"UPDATE {res.table} SET is_active = $2 WHERE id = $1", item_id, active)  # noqa: S608
        await audit(conn, acc, entity_type=res.entity, entity_id=item_id,
                    action="restore" if active else "archive", company_id=company)
        return await fetch_one(conn, item_id)

    @router.post(f"{res.path}/{{item_id}}/archive", name=f"archive_{name}")
    @secured(requires=["permission:admin"], db_access="write")
    async def archive_item(
        item_id: UUID,
        conn: asyncpg.Connection = Depends(db),
        acc: Access = Depends(get_access),
    ) -> dict[str, Any]:
        return await _set_active(conn, acc, item_id, False)

    @router.post(f"{res.path}/{{item_id}}/restore", name=f"restore_{name}")
    @secured(requires=["permission:admin"], db_access="write")
    async def restore_item(
        item_id: UUID,
        conn: asyncpg.Connection = Depends(db),
        acc: Access = Depends(get_access),
    ) -> dict[str, Any]:
        return await _set_active(conn, acc, item_id, True)

    @router.delete(f"{res.path}/{{item_id}}", status_code=204, name=f"delete_{name}")
    @secured(requires=["permission:admin"], db_access="write")
    async def delete_item(
        item_id: UUID,
        conn: asyncpg.Connection = Depends(db),
        acc: Access = Depends(get_access),
    ) -> None:
        _, company = await owner_of_row(conn, res, item_id)
        acc.ensure_manage(company)
        try:
            await conn.execute(f"DELETE FROM {res.table} WHERE id = $1", item_id)  # noqa: S608
        except (UniqueViolationError, ForeignKeyViolationError, CheckViolationError) as exc:
            raise db_errors(exc) from exc
        await audit(conn, acc, entity_type=res.entity, entity_id=item_id, action="delete",
                    company_id=company)
