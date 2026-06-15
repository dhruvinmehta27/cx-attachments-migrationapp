# C4C Attachment Migration App

A **SAP Cloud Application Programming Model (CAP)** application with a **SAP Fiori
elements** UI that lets a user browse **SAP Cloud for Customer (C4C)** accounts and
their attachments and migrate selected attachments to a **configurable target
REST/OData endpoint**. Every migration is recorded as an auditable job.

```
 SAP C4C  ──(OData, live)──►  CAP MigrationService  ──(REST/OData)──►  Target endpoint
 (source)                      + Fiori elements UI                      (configurable)
                                       │
                                       ▼
                               MigrationJobs / Items
                               (audit log, HANA/SQLite)
```

## Capabilities

- **Browse accounts** live from C4C (`AccountCollection`) in a Fiori List Report.
- **Drill into an account** to see its attachments (`AccountAttachmentFolder`).
- **Select attachments** in the table and **Migrate** them, or migrate **all**
  attachments of an account via the object-page action — both ask for the
  **target endpoint**.
- Each run streams the binary content from C4C and POSTs it to the target,
  recording the result per file.
- **Audit log** (second Fiori app) shows every job with per-item status.

## Project layout

| Path | Purpose |
|------|---------|
| `db/schema.cds` | Local persistence: `MigrationJobs`, `MigrationItems` (audit log) |
| `srv/external/C4C_ODATA.cds` | External model of the C4C `c4codataapi` service |
| `srv/migration-service.cds` | Service: `Accounts`, `Attachments` (remote) + jobs, actions |
| `srv/migration-annotations.cds` | Fiori elements UI annotations |
| `srv/migration-service.js` | Migration logic (handlers for the two actions) |
| `srv/lib/c4c-client.js` | Reads accounts / attachments / binaries from C4C |
| `srv/lib/target-client.js` | Pushes content to the target endpoint |
| `app/migration` | Fiori elements app: Accounts → Attachments → Migrate |
| `app/jobs` | Fiori elements app: migration audit log |
| `mta.yaml`, `xs-security.json` | Cloud Foundry deployment descriptors |

## Service API (`/migration`)

- `Accounts` (read-only, remote) with bound action
  `migrateAttachments(targetEndpoint, attachmentIDs[])` — migrates the given
  attachments (or all when the list is empty).
- `Attachments` (read-only, remote) with bound action `migrate(targetEndpoint)` —
  migrates a single / multi-selected attachment.
- `MigrationJobs`, `MigrationItems` (read-only) — the audit log.

## Configuration

### Source — SAP C4C (`cds.requires.C4C_ODATA`)
Connectivity resolves through a destination named **`SAP_C4C`** in production,
pointing at the tenant's `/sap/c4c/odata/v1/c4codataapi` service. For local
development set the base URL (and credentials via env, see below):

```jsonc
// package.json → cds.requires.C4C_ODATA["[development]"]
"credentials": { "url": "https://<your-c4c-tenant>.crm.ondemand.com" }
```

Provide C4C basic-auth credentials locally without committing them, e.g. in
`.cdsrc-private.json` (git-ignored) or via environment:

```jsonc
// .cdsrc-private.json
{ "requires": { "C4C_ODATA": { "credentials": {
    "username": "…", "password": "…" } } } }
```

### Target — generic endpoint (`cds.requires.TARGET_ENDPOINT`)
- If the `targetEndpoint` passed to the action is an **absolute `http(s)://` URL**,
  content is POSTed directly to it.
- Otherwise it is treated as a **path** on the destination **`MIGRATION_TARGET`**
  (base URL + auth resolved by the destination service).

The payload sent per attachment is JSON:
```json
{ "fileName": "...", "mimeType": "...", "contentBase64": "...",
  "accountID": "...", "accountName": "...", "sourceSystem": "SAP-C4C", "sourceID": "..." }
```

## Run locally

```bash
npm install
cds watch            # serves the service + Fiori apps at http://localhost:4004
```

Open <http://localhost:4004> for the service index, then the Fiori apps under
`/migration/webapp/index.html` and `/jobs/webapp/index.html`. The audit-log app
works against the local DB out of the box; the Accounts/Attachments apps require
a reachable C4C tenant (see configuration above).

## Deploy to SAP BTP, Cloud Foundry

```bash
npm i -g mbt
mbt build                      # produces mta_archives/*.mtar
cf deploy mta_archives/*.mtar
```

Then in the BTP cockpit create the destinations the app expects:
- **`SAP_C4C`** → the C4C tenant OData base URL with valid auth.
- **`MIGRATION_TARGET`** → the target system (only needed for relative endpoint paths).

Assign the **`C4C_Migration_User`** role collection to users who may run migrations.
