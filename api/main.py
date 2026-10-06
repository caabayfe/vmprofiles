"""vm-profiles — `api` component.

FastAPI service built on the YARP app SDK (`nttdsp.web`, baked into the base
image). Every route is `@secured`; `create_app` wires the asyncpg pool,
DSP-Token auth, the DomainError -> HTTP boundary and /health.
Full reference: yarp_guide_get("secure-endpoints").

Modules (one domain per file):
  access.py        roles, the `permission:` resolver, scope helpers, audit
  crud.py          generic scope-aware CRUD used by catalog.py
  catalog.py       OS / software / roles / sizes + vCenter infrastructure
  lookups.py       one-shot payload for the profile wizard
  profiles.py      VM profiles + expanded spec
  requests_api.py  provisioning requests (submit / approve / reject)
  admin.py         /me, company cache, role assignments, audit log
  inventory*.py    external vCenter inventory feed (snapshot sync)
  profile_spec.py  expanded profile spec (+ requester adjustment limits)
  capacity.py      capacity warnings for requests
  ipam.py          static IP allocation from network pools

Served at /l/yarp/<env>/<space>/vm-profiles/api/; the SPA calls `api/...`.
"""

import os
import traceback

from fastapi import Request
from fastapi.responses import JSONResponse
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from nttdsp.web import create_app

import access  # noqa: F401  registers the `permission:` access resolver
from admin import router as admin_router
from catalog import router as catalog_router
from inventory import router as inventory_router
from ipam import router as ipam_router
from lookups import router as lookups_router
from profiles import router as profiles_router
from requests_api import router as requests_router

app = create_app(
    title="vm-profiles-api",
    routers=[admin_router, lookups_router, catalog_router, inventory_router, ipam_router, profiles_router, requests_router],
)
FastAPIInstrumentor.instrument_app(app)


# Dev-only: full tracebacks in 500 responses. YARP_ENV is platform-injected
# (dev/pre/prod). DomainErrors (NotFound -> 404, …) are handled by the SDK.
if os.environ.get("YARP_ENV", "dev") == "dev":

    @app.exception_handler(Exception)
    async def _dev_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        return JSONResponse(status_code=500, content={"detail": str(exc), "traceback": "".join(tb)})
