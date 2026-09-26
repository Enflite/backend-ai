# SyteLine Domain Expertise — Knowledge Pack

**Status:** generic product knowledge, no tenant data. Injected into the
system prompt on SyteLine turns (`sytelineToolsAvailable`), so the model
reasons like a veteran SyteLine practitioner even with no tenant-specific
training. Runtime copy: `backend/src/chat/sytelineExpertKnowledge.ts`
(a test asserts the two stay in sync).

**Scope note:** SyteLine is Infor CloudSuite Industrial (CSI), versions
7.x–10.x+. Behavior varies by version and tenant configuration. IDO names
marked "verify" are community-corroborated, not officially documented —
confirm via `IdoCollections`/`IdoProperties` introspection on a live
tenant before treating them as ground truth.

## 1. Platform: Mongoose and IDOs

- SyteLine runs on the **Mongoose** metadata-driven platform: Forms are the
  UI, **IDOs (Intelligent Data Objects)** are the smart business layer, and
  Application Event Handlers hold business-process logic. Custom metadata is
  kept separate from the base application; **FormSync** merges customizations
  with vendor form definitions at upgrade time.
- All application-database access goes through **IDOs via the IDO runtime
  service**. Core operations: `LoadCollection`, `UpdateCollection`, `Invoke`
  (plus `OpenSession`). An IDO is a flattened property view over one or more
  base SQL tables.
- Officially documented IDO names: `SLCustomers` (customers), `SLCos`
  (customer-order headers). Community-corroborated (verify on tenant):
  `SLItems`, `SLCoitems`, `SLPOs`, `SLPoItems`, `SLJobs`, `SLJobRoutes`,
  `SLJobmatls`, `SLLocations`.

## 2. Core data model

Key SQL tables (multi-site replication views append `_all`; base tables
drop the suffix). Spelling matters: it is **`matltran`**, not `matltrans`.

- **Customers / orders:** `customer_mst`, `co_mst` (`co_num`, `cust_po`),
  `coitem_mst` (`co_num`, `item`, `u_m`, `stat`, `due_date`, `promise_date`,
  `release_date`, `qty_ordered`, `cust_po`).
- **Purchasing:** `po_mst` (`po_num`), `poitem_mst` (`po_release`, `item`,
  `due_date`, `prom_date`, `qty_ordered_conf`, `unit_cost_conv`, `stat`).
- **Inventory:** `item`, `itemwhse` (per-site item record), `matltran`
  (every material transaction — the audit trail), lot/serial masters.
- **Manufacturing:** `job`, `jobmatl` (`job`, `suffix`, `sequence`, `item`,
  `oper_num`, `matl_qty`, `qty_released`, `qty_issued`, `u_m`, `scrap_fact`,
  `backflush`, `bflush_loc`, `matl_type`), `jobroute`, `jobtran` (labor
  transaction audit trail).

## 3. Status lifecycle — statuses are load-bearing

The Scheduler and APS interpret transactions **by status code**. Statuses
are not cosmetic.

- **Customer orders / lines:** `Planned` (does not update the customer's
  On Order Balance) → `Ordered`/`Open` (credit-checked, updates balances) →
  `Complete` (header). Blanket lines: Planned / Ordered / Complete.
  Community-mapped DB codes: `P` = Planned, `O` = Ordered — verify per
  tenant. Switching a line from Planned to Ordered fires the credit check.
- **Purchase orders:** `Planned` (still in planning, no firm order) →
  `Ordered` (ready to process) → `Open` → History (purge).
- **Jobs:** `Firm` (the default status for a new job) → `Released`
  (authorized for shop-floor execution) → `Complete` → `History`
  (year-end purge candidate). `Stopped` is available to halt a job.
  `PLN` is **not** a job status — it is a planned-order record created by
  MRP/APS; *firming* a PLN order converts it into a real job or PO.
  Close is explicit: set Status to `Complete` on the Job Orders form (or
  complete the job through a job transaction) — a job does not close
  itself as a side effect of receiving everything.
- **"Past Due"** (community-reported pattern, verify per tenant):
  quantity ordered > quantity received, Status = 'O', due date < today.

## 4. Core workflows

- **Order-to-cash:** Estimate/quote → on win, the estimate can generate the
  sales order and work order together. Lines start Planned; Ordered fires
  credit check and updates On Order Balance. Pick/pack/ship (packing slip,
  BOL) reduces on-hand; invoicing follows shipment. EDI: inbound 850
  (demand/PO), 856 (ASN), 810 (invoice), 860 (change); outbound mirrors.
- **Procure-to-pay:** Requisitions → PO (Planned vs Ordered as above). PO
  receipt **increases** on-hand; PO returns reduce it.
- **Manufacturing:** define operations (setup/run standards, work center,
  resources, cost rates) → attach materials to operations → **release** the
  job → labor via Factory Track (Start Run), material issues, **move
  transactions** (move quantities between operations; can receive completed
  qty into a stockroom location), scrap reporting → job receipt into
  inventory → manually set Status to Complete.
- **Planning — MRP:** (1) plan independent demand (forecasts, customer
  orders); (2) net against on-hand and scheduled receipts; (3) create
  planned orders for net requirements; (4) explode planned-order demand
  through the BOM into dependent component demand. The planner **firms** a
  PLN order into a job or PO. The **Order Action Report** gives
  reschedule/cancel guidance; a **Net Change** flag on items limits
  replanning scope.
- **Planning — APS:** like MRP but **allocates on-hand and planned supply to
  demands by priority**, with a supply-usage tolerance; it can switch supply
  between demands, generating "Move In/Move Out" exception messages. APS
  controls PLN projected dates — they may change and are not user-editable
  like firm dates.

## 5. Expert concepts

- **On-hand vs allocated vs available (ATP).** On-hand is physical qty;
  allocated is reserved by open demand (order lines, job materials);
  the standard convention is available = on-hand − allocated (exact ATP
  bucket math varies by version/tenant — treat as the baseline, not the
  tenant's formula). **Available can go negative** — read it by cause:
  with non-negative on-hand, negative available means allocated demand
  exceeds physical supply (that is the diagnostic signal, reported
  honestly, never clamped); with negative on-hand and little or no
  allocation, the negative comes from on-hand itself (see the negative
  inventory rules below).
- **Backflushing.** Completing an operation/job auto-issues its materials
  based on completed quantity. Default set at item level, overridable per
  Job Materials record (`backflush`, `bflush_loc`). Every material
  transaction lands in `matltran`.
- **Negative inventory.** SyteLine explicitly allows it via the **On Hand
  Neg Flag on the Inventory Parameters form**; the exception list includes
  "Initial Quantity On Hand Negative." Reducers of on-hand: job material
  issues, customer-order shipments, PO returns, stock adjustments, cycle
  counts, physical-inventory postings. Hard rule: **on-hand serialized
  inventory cannot go negative** — negatives always point at non-serialized
  flows or the Neg Flag.
- **Dates are distinct fields.** `due_date`, `promise_date`, `release_date`
  on order lines are separate; when promised date is blank, due date is
  used. Never conflate them.
- **Credit hold.** Exceeding the credit limit saves the line as **Planned**
  instead of Ordered. On Order Balance is cumulative across replicating
  sites in multi-site; the **originating site controls the order's
  credit-hold status**.
- **Lot/serial tracking.** Enabled per item (Items form → Controls tab →
  Lot Track). An item can be both lot- and serial-tracked. Lot numbers can
  be **preassigned** on a PO, transfer order line, job, or co-job — they
  stay allocated/unusable until the source is Complete.
- **Labor & overhead.** Variable Labor Overhead = Total Hrs × Var Lbr Ovhd
  Rate; Fixed Labor Overhead = Total Hrs × Fix Lbr Ovhd Rate (rates from
  the Departments form or the job operation); `jobtran` is the labor audit
  trail (job, production schedule, JIT, work center). Cost buckets:
  material, labor, machine and labor overhead.
- **Scrap factor** on job materials is a multiplier of completed qty
  (e.g. 1.5 = 50% more material consumed than the BOM calls for).

## 6. Diagnostic heuristics — the veteran's checklist

- **"Why is this order late?"** Pull the order → open lines with
  `promise_date`/`due_date` → for each open line check item availability
  (available < open qty = short) → for short items check open POs
  (`prom_date` vs today; qty received vs ordered — a late PO, not the shop
  floor, is the usual culprit) and work orders (status: Released but not
  Complete = behind; PLN = not even firmed yet) → for manufactured items
  explode the BOM and check each component's availability → check the
  customer for credit hold (an order stuck Planned never ships).
- **"Why is inventory negative?"** Check the Neg Flag; look at `matltran`
  for the item — ship-before-receipt timing, backflush over-reporting
  (completed qty overstated), duplicate issues, or adjustments. If the item
  is serialized, treat the negative as a data-integrity red flag.
- **"Why won't this job release/close?"** Release blockers: a planned
  order still at PLN (firm it into a job first), missing BOM (system
  prompts to copy the current BOM), configurable item with incomplete
  configuration (Status field stays disabled). Close is an explicit act:
  set Status to Complete, or complete via a job transaction — finishing
  the work does not close the job by itself.
- **New job, no BOM:** SyteLine prompts to copy the current BOM — normal,
  not an error.

## 7. Vocabulary

- **Forms:** Customers, CustomerOrders, Items, Item Warehouses,
  PurchaseOrders, Purchase Order Lines, Purchase Order Requisitions,
  Vendors, Estimates, Job Orders, Job Operations, Job Materials,
  Job Bill of Material, Job Transactions, Production Schedules,
  Production Schedule Items, Material Transactions, Material Allocation,
  Demand Detail – Scheduler, Order Action Report, Planning Detail,
  Material Planner Workbench, Shop Floor Control Parameters, Departments,
  Engineering Workbench, Copy Routing/BOM, Lot/Serial Master,
  Location Inventory Detail, Job Packet.
- **Terms:** operation, work center, resource group, backflush, co-product /
  by-product, phantom BOM, alternate parts, ECN (Engineering Change
  Notice), kitting, JIT/kanban, Factory Track, BOL, blanket order, transfer
  order, outside operation, rework job, estimate job, preassigned lots,
  bucket costing, firm planned order, net change.

## 8. How to talk about SyteLine

- Name real tables, fields, forms, and IDOs when they sharpen the answer;
  never invent IDO or field names. If unsure of an exact name, describe
  the concept and say the name should be confirmed on the tenant.
- Reason from records, not from vibes: every factual claim about the
  tenant's data traces to a tool result. Domain knowledge explains *what
  the records mean*; it never substitutes for them.
- Tenant configuration varies (versions 7.x–10.x+, custom fields,
  custom statuses). Treat this pack as the product baseline; the tenant's
  `IdoCollections`/`IdoProperties` and live data are ground truth.

## 9. Form projects (custom form fields)

- Never change Infor-owned SQL Tables, IDOs, or Vendor forms: new fields
  are **UET-only**. Import forms with **FormSync** at Site scope. Build and
  test on **TRN** first, then production.
- **Naming:** `Uf_ENF_<Name>` user fields, `ENF_<Area>` classes,
  `ENF_<Name>` user defined types. The form binds
  `object.<alias>Uf_ENF_<Name>` (e.g. `object.lotUf_ENF_Test`). The table
  alias is an **assumption** until confirmed in Design Mode (Staging check
  A); it does not show in the IDOs → Properties export.
- **Export handling:** form XML is UTF-8 with BOM and CRLF line endings.
  Keep originals byte-for-byte; never re-serialize the XML. If the TRN and
  production originals differ, **stop** — production has local changes that
  must be scoped first. If an attached export lost BOM or CRLF, ask for a
  byte-for-byte re-upload instead of "fixing" it.
- Every new field gets a grid column; every new or changed component is
  highlighted purple so testers can find it. Generated files are rebuilt
  only through the build scripts (deterministic rebuild check).
- The AI works Git/project files only. SyteLine, UET, and FormSync steps
  are numbered human runbook steps; never claim one succeeded until the
  human confirms it.
