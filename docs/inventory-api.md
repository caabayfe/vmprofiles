# Inventory feed API

External systems (a vCenter collector, vRO, Ansible, a CMDB…) push the
infrastructure of a vCenter into **vm-profiles** so admins don't type it by
hand. One call carries a **full snapshot of one vCenter**: datacenters,
clusters, resource pools, VM folders, datastores, networks, templates and the
cluster ↔ datastore / network attachments.

Base URL (per environment):

| Env  | URL |
|------|-----|
| dev  | `https://intiop.portal.nttltd.global.ntt/l/yarp/dev/ibiol/vm-profiles/api` |
| pre  | `https://intiop.portal.nttltd.global.ntt/l/yarp/pre/ibiol/vm-profiles/api` |
| prod | `https://intiop.portal.nttltd.global.ntt/l/yarp/prod/ibiol/vm-profiles/api` |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `PUT`  | `/inventory/vcenter` | Sync one vCenter from a snapshot. `?dry_run=true` previews without writing. |
| `GET`  | `/inventory/vcenters` | vCenters this caller may sync, with `last_synced_at`. |
| `GET`  | `/inventory/vcenters/{id}` | Current inventory in the **same shape** as the PUT body. |
| `GET`  | `/inventory/syncs?vcenter_id=` | Sync history (also shown in the UI: vCenter → *Sync history*). |

## Authentication and access

Requests go through the portal like any other YARP API call; the app sees the
caller as a Digital Fabric (DF) user.

1. **Identity.** The feeding system authenticates as an Azure managed identity
   or service principal mapped to a DF user (a service account). Mapping is a
   one-time step done by the YARP platform team (ADR
   `2026-06-25-workload-caller-auth`). A YARP job in another app is added to
   this API's `callableBy` list instead.
2. **Token.** Mint an Azure AD token for the portal audience and send it as
   `Authorization: Bearer <token>`; the portal exchanges it into the internal
   DSP-Token.
3. **Role in vm-profiles.** An admin grants that DF user the
   **Inventory sync** role on *Administration → Access* (search the service
   account or paste its DF user ID):
   - *Global* — may sync any vCenter, generic or company-owned, and may
     register a company the app doesn't know yet.
   - *Company X* — may only sync vCenters owned by company X.

   Global and company admins may also call the endpoint for the vCenters they
   manage (useful for testing).

```python
from azure.identity import DefaultAzureCredential
import httpx

PORTAL = "https://intiop.portal.nttltd.global.ntt"
API = f"{PORTAL}/l/yarp/prod/ibiol/vm-profiles/api"
token = DefaultAzureCredential().get_token(f"{PORTAL}/.default").token

snapshot = {...}  # see below
r = httpx.put(f"{API}/inventory/vcenter", params={"dry_run": "true"},
              headers={"Authorization": f"Bearer {token}"}, json=snapshot, timeout=120)
r.raise_for_status()
print(r.json()["summary"], r.json()["warnings"])
```

## Snapshot body

```json
{
  "source": "vc-collector@ops01",
  "prune": true,
  "vcenter": {
    "fqdn": "vc01.acme.local",
    "name": "vc01",
    "moref": "5f1c…-instance-uuid",
    "company": { "id": "18e7c9fc-cff1-4e89-bb17-017125d52131", "name": "Acme" },
    "description": "Madrid production",
    "credential_secret_name": "vc01-svc-account"
  },
  "datacenters": [
    {
      "name": "DC-MAD", "moref": "datacenter-2",
      "folders": [ { "path": "/Prod/Web", "moref": "group-v10" } ],
      "clusters": [
        {
          "name": "CL-A", "moref": "domain-c7",
          "resource_pools": [ { "name": "RP-Gold", "path": "/Resources/RP-Gold", "moref": "resgroup-9" } ],
          "datastores": [ "DS-01", "datastore-12" ],
          "networks":   [ "VLAN100" ]
        }
      ]
    }
  ],
  "datastores": [
    { "name": "DS-01", "moref": "datastore-11", "type": "vmfs", "capacity_gb": 4096 },
    { "name": "DS-02", "moref": "datastore-12", "type": "vsan", "capacity_gb": 8192 }
  ],
  "networks": [
    { "name": "VLAN100", "moref": "dvportgroup-21", "type": "dvportgroup", "vlan_id": 100 }
  ],
  "templates": [
    { "name": "tpl-w2022", "moref": "vm-501", "guest_id": "windows2019srvNext_64Guest", "os_disk_gb": 90 },
    { "name": "tpl-rhel9", "operating_system_id": "2418ba1d-51e9-4de6-8d4f-82326b068926" }
  ]
}
```

Field notes:

- **`vcenter.fqdn` + `vcenter.company`** identify the vCenter (case-insensitive
  FQDN, unique per scope). Omit `company` for a generic vCenter. The vCenter
  is created on first sync.
- **`moref`** (VMware managed-object reference) is optional everywhere but
  **strongly recommended**: with it, renames in vCenter become renames here
  instead of archive + create.
- **Datastores and networks** are declared once at vCenter level; clusters
  reference them **by name or moref** in `datastores` / `networks`.
- **Templates** need an operating system from the app's catalog: give
  `operating_system_id`, or `guest_id` matched (case-insensitively) to the
  OS's *VMware guest ID* in *Catalog → Operating systems*. Templates whose OS
  can't be resolved are **skipped with a warning** (an already-known template
  keeps its previous OS).
- Enumerations: datastore `type` ∈ `vmfs | nfs | vsan | vvol`; network `type`
  ∈ `standard | dvportgroup | nsx`; `vlan_id` 0–4094.
- Limits per call: 200 datacenters, 500 clusters per datacenter, 5000
  datastores, 5000 networks, 2000 templates.

## How the sync behaves

- **Matching** happens within the same parent: by `moref` first, then by name
  (folders by path). Matched rows are updated; unknown items are created.
- **Prune (default `true`)**: items of this vCenter missing from the snapshot
  are **archived, never deleted** — VM profiles may still point at them, and
  archived items just disappear from pickers. If they come back in a later
  snapshot they are **restored**. With `"prune": false` the call only adds and
  updates.
- **Attachments**: cluster ↔ datastore / network links are made to match the
  snapshot. A link that a VM profile still uses (a disk on that datastore, a
  NIC on that network in that cluster) is **kept** and reported in `warnings`.
- **No moves**: an item that changed parent (e.g. a cluster moved to another
  datacenter) is archived under the old parent and created under the new one.
- **All or nothing**: the whole snapshot is applied in one transaction. If any
  statement fails (e.g. a rename collides with an existing name) nothing
  changes and the call returns an error.
- **Idempotent**: sending the same snapshot twice yields `change_count: 0`.
  `GET /inventory/vcenters/{id}` → `PUT` round-trips unchanged.

## Response

```json
{
  "sync_id": "67568fa7-…",
  "vcenter_id": "b7f9503b-…",
  "dry_run": false,
  "summary": {
    "vcenters": { "unchanged": 1 },
    "datacenters": { "unchanged": 1 },
    "clusters": { "updated": 1, "archived": 1 },
    "datastores": { "updated": 1, "unchanged": 1 },
    "cluster_datastores": { "kept_in_use": 1 },
    "templates": { "unchanged": 2, "skipped": 1 }
  },
  "change_count": 4,
  "changes": [
    { "entity": "clusters", "action": "updated", "name": "CL-A-renamed", "changed": { "name": "CL-A-renamed" } },
    { "entity": "clusters", "action": "archived", "name": "CL-B" }
  ],
  "changes_truncated": false,
  "warnings": [
    "kept DC-MAD/CL-A-renamed → DS-01: still used by a VM profile",
    "skipped template tpl-mystery: operating system not found (…)"
  ]
}
```

Actions: `created`, `updated`, `restored`, `archived`, `unchanged`,
`attached`, `detached`, `kept_in_use`, `skipped`. `vcenter_id` is `null` for a
dry run of a vCenter that doesn't exist yet. At most 1000 `changes` are
listed; `change_count` is the full number.

## Errors

| Status | When |
|--------|------|
| `403` | Caller lacks the Inventory sync role for this vCenter's scope. |
| `422` | Invalid snapshot: duplicate names at one level, a cluster referencing an undeclared datastore / network, an unknown company without `company.name`, schema violations. |
| `409` | Applying would break a uniqueness rule (e.g. two items renamed onto each other). Nothing was changed. |

## Recommended feed loop

1. `PUT …?dry_run=true` and log the summary and warnings.
2. If the change count looks sane (no mass archive from a partial collection),
   `PUT` for real.
3. Alert on non-empty `warnings` — they usually mean a template OS that needs
   to be added to the catalog, or an attachment a profile still depends on.
