# River Mobility — Salesforce Org Data Model Reference

> **Purpose:** Reference for future development against the River Mobility Salesforce org.
> Captures the org identity, installed packages, what data exists today, the full custom-object
> catalog grouped by business domain, and field/relationship detail for the core objects.

| | |
|---|---|
| **Company** | River Mobility Private Limited (EV / electric two‑wheeler manufacturer) |
| **Org type** | Salesforce **core** platform (CRM + Field Service) — **not** Marketing Cloud |
| **Sandbox** | `rrdev` |
| **My Domain** | `rivermobilityprivatelimited2--rrdev.sandbox.my.salesforce.com` |
| **API version** | 67.0 |
| **CLI alias** | `mysandbox` |
| **Documented on** | 2026-06-09 |

---

## 1. Installed packages / platform features

| Package / feature | Namespace | Purpose |
|---|---|---|
| **Marketing Cloud Connect** | `et4ae5` | Connector to Salesforce Marketing Cloud (Email Send, Triggered Send, Business Unit, Mobile/SMS). **Installed but currently holds no data** in this sandbox. |
| **OmniStudio / Vlocity** | `omnistudio` | Guided flows, DataRaptors (Data Mapper), Cards, Integration Procedures. |
| **Calendly** | `Calendly` | Scheduling integration. |
| **Field Service** | (standard) | WorkOrder (relabeled "Job Card"), ServiceAppointment (relabeled "Service Reminder"), ServiceResource, ServiceTerritory, WorkType. |

> **On the "is this Marketing Cloud?" question:** No. This is a core Salesforce org. Marketing Cloud
> Connect (`et4ae5`) is installed as a managed package, but every Marketing Cloud object is empty —
> no Business Units, Email Sends, or results. MC is provisioned/connected, not in use here.

---

## 2. Data census — what actually has data

This is a **configuration/development sandbox**: well-stocked with master/reference data
(product catalog, price books, cities) but only a handful of real transactional/customer records.

### Standard objects with data

| Object | Records | Notes |
|---|---:|---|
| PricebookEntry | 15,513 | Product pricing |
| Product2 | 1,973 | Product / parts catalog |
| User | 140 | Org users |
| Pricebook2 | 32 | Price books |
| Lead | 15 | Sales leads |
| Contact | 9 | |
| Account | 6 | |
| Order (standard) | 4 | **Operational order object** |
| OrderItem | 4 | |
| Asset | 4 | Sold vehicles |
| Opportunity | 1 | |

### Custom objects with data

| Object | Records | | Object | Records |
|---|---:|---|---|---:|
| City__c | 58 | | Order_Payment__c | 3 |
| Integration_Log__c | 11 | | Payment__c | 3 |
| Follow_Up__c | 7 | | Order_Invoice__c | 2 |
| Test_Drive__c | 7 | | Order__c | 1 |
| Pin_Code__c | 4 | | Insurance__c | 1 |
| Software_Version__c | 4 | | Feedback_Response__c | 1 |
| OrderCounter__c | 1 | | Lead_Report_Id__c | 1 |
| Integration_Log_Emails__c | 1 | | et4ae5__ET4AE_Config__c | 1 |

Integration credential/config singletons also each have 1 record: `ClearTax_Api_Details__c`,
`EW_API_Details__c`, `PineLabs_API_Config__c`, `RSA_Client_Creds__c`, `SAP_API_Creds__c`,
`Website_Creds__c`, `WhatsappIntegration__c`.

**All other objects (≈100 custom + Cases, Campaigns, Subscriptions, WorkOrders,
ServiceAppointments, Tickets, Feedback, Warehouse/Inventory, all `et4ae5__*`) currently
have 0 records.**

> ⚠️ Don't assume an empty object is unused — most of the data model below is built out and
> wired up; this sandbox just hasn't been loaded with transactional data.

---

## 3. ⚠️ Critical gotchas for developers

1. **Two Order objects exist.** There is a sparse custom `Order__c` **and** the standard
   `Order`. All payment/invoice/work‑order links point at the **standard `Order`** — that is the
   operational order entity. `Order__c` is nearly empty and largely vestigial. Always confirm which
   one a field references.
2. **Account is multi-purpose.** Customers, dealers (DODO), company stores (COCO), and service
   centers are *all* Accounts, differentiated by `Type` / `Store_Type__c`. `ParentId` and
   `Service_Center__c` are self-references.
3. **Contact is multi-purpose.** Holds both end customers and internal staff (see `Role_Type__c`,
   `Designation__c`).
4. **Relabeled standard objects:** `WorkOrder` = "Job Card", `ServiceAppointment` =
   "Service Reminder". `TFR__c` carries the label "VIN Cut off".
5. **Master-Detail vs Lookup:** the describe API reports references generically. Relationships marked
   **MD?** below are `required` references and very likely master-detail; confirm in Setup if exact
   cascade/sharing behavior matters.

---

## 4. Custom object catalog (by business domain)

All 121 custom objects, grouped. `__c` suffix omitted in the list for brevity.

### Sales & lead management
`Test_Drive`, `Duplicate_Lead`, `Lead_Transfer_History`, `Lead_Report_Id`, `Follow_Up`,
`Offers`, `River_Website_Details`, `Questionnaire`

### Orders, payments & invoicing
`Order`, `OrderCounter`, `Order_Invoice`, `Order_Payment`, `Payment`, `Payment_Split` (label
"Log Payment"), `PO_Payments`, `Work_Order_Payment`, `Daily_Ledger`, `Finance`, `Insurance`,
`Subsidy`

### Subscriptions & service plans
`Subscription`, `Subscription_Product`, `Subscription_Instance`

### Service / Field operations
`Appointment`, `Appointment_Slot`, `Appointment_Slot_Item`, `Service_Appointment_Log`,
`Service_Bay`, `Pre_Delivery_Inspection`, `Pre_Delivery_Inspection_Item`, `Checklist`,
`Required_Labour`, `Required_Product`, `RR_Additional_Job_Recommended`, `RR_Customer_Voice`,
`Skipped_Action_Plan`, `Action_Plan_Template` (obsolete), `BenefitManagementRecertification`,
`VOR` (Vehicle Off Road)

### Quality / field reporting (TFR)
`TFR` (label "VIN Cut off"), `TFR_Sample`, `TFR_Part_Effect`, `TFR_Labour_Effect`,
`Field_Fix`, `Failure_Code`, `Software_Version`, `Warranty_Prior`

### Inventory & supply chain
`Warehouse`, `Inventory_Lot`, `Manufacturer_Unit`, `Sales_Consumption`, `Create_Batch`
(label "Batch"), `Batch_Processing`, `Batch_Processing_Detail`

### Customer experience / feedback
`Customer_Concern`, `Customer_Feedback`, `Feedback`, `Feedback_Question`, `Feedback_Response`,
`Feedback_Response_Answers`, `Post_Service_Feedback`, `Ticket`

### Reference / master data
`City`, `Pin_Code`

### Assignment / routing
`Assignment_Group`, `Assignment_Group_Member`, `Assignment_Log`

### Integrations & credentials (config singletons)
`SAP_API_Creds`, `ClearTax_Api_Details`, `EW_API_Details`, `PineLabs_API_Config`,
`PineLabs_Machine_Info`, `RSA_Client_Creds`, `RSA_Details_c`, `RSA_Token_Manager`,
`Website_Creds`, `WhatsappIntegration`, `River_Website_Details`, `Salesforce_Support`

### Logging & diagnostics
`Integration_Log`, `Integration_Log_Emails`, `Exception_Log`, `Object_DML_Log`,
`User_Tracking`, `Data_Processing_Engine_Node_Metric`

### Managed-package objects (don't modify directly)
`et4ae5__*` (Marketing Cloud Connect — Email/Mobile Send, Business Unit, Triggered Send, etc.),
`omnistudio__*` (Vlocity Data Mapper, DataPack, Tracking, Scheduled Job, etc.),
`Calendly__*` (CalendlyAction, CalendlyLink, Routing Form).

---

## 5. Core object schemas & relationships

Relationship legend: **MD?** = required reference (likely master-detail), **L** = lookup.
Only key custom fields and *all* relationship fields are listed. Standard system fields omitted.

### Lead — "Lead" (standard, EV sales funnel)
- **Status flow:** New → RNR → Test Ride → Follow Up → Ready For booking → Converted / Close lost / Junk
- **Key fields:** `Source__c` (Walk-In, Outdoor Activations, Telephone, CSD, CPC…),
  `Buying_Span__c` (Within 7/15 Days / a Month / Later), `Lost_Reason__c`, `Qualified_Lead__c`,
  `Lead_Age__c`, `Home_Test_Ride__c`, `Instore_Test_drive__c`, `Test_Ride_Given__c`,
  `Test_ride_Start_date__c`/`_end_date__c`, `Verified__c`, `Future_Lead__c`, `Is_Order_Created__c`,
  `Dealer_Code__c`, `Repeat_Lead_Within_90_Days__c`, UTM fields
  (`Utm_Source__c`, `Utm_Campaign__c`, `Utm_Medium__c`, `Campaign_Id__c`, `Adset_Id__c`)
- **Relationships:** `ConvertedAccountId`→Account, `ConvertedContactId`→Contact,
  `ConvertedOpportunityId`→Opportunity, `PartnerAccountId`→Account,
  `PreferredSeller__c`→Account (dealer/store), `AG_Related_to__c`→Assignment_Group__c (routing)

### Account — "Account" (customers + dealers + stores + service centers)
- **Key fields:** `Center_Code__c`/`DealerCode__c`, `Store_Type__c` (COCO, DODO), `Store_Name__c`,
  `Type` (Customer, Partner, Dealer, COCO Store, Service Center), `GSTIN_Number__c`,
  `Company_GSTIN_name__c`, `CIN__c`, `PAN_Number__c`, bank fields
  (`Account_Number__c`, `Bank_Name__c`, `Beneficiary_Name__c`, `IFSC__c`, `Swift_Code__c`),
  `Invoice_Sequence__c`, `RR_Customer_Care_Email__c`, `RR_Customer_HelpLine_Number__c`,
  `Date_of_Birth__c`, `Gender__c`, `Occupation__c`
- **Relationships:** `ParentId`→Account (hierarchy), `Service_Center__c`→Account (self-ref),
  `City__c`→City__c, `OperatingHoursId`→OperatingHours

### Contact — "Contact" (customers + internal staff)
- **Key fields:** `Role_Type__c` (Sales, Service), `Designation__c`
  (WM, ASM, CRE, CRM, GM, Parts, PDI, RSM, SA, SP, PS…), `Store_Type__c`, `Store_Name__c`,
  `Dealer_Code__c`, `Customer_ID__c` (Booking/Customer ID), `Primary_Contact__c`
- **Relationships:** `AccountId`→Account, `ReportsToId`→Contact, `Location__c`→Location

### Order (standard) — operational order entity
Linked from `Order_Payment__c.Order__c`, `Order_Invoice__c.Order__c`, `WorkOrder.Account_Order__c`.

### Order__c — "Order" (custom, sparse / mostly vestigial)
- **Key fields:** `InvoiceNumber__c`. No direct Account/Contact lookup. Prefer the standard `Order`.

### Payment__c — "Payments" (standalone payment ledger)
- **Key fields:** `Amount__c`, `Transaction_Id__c` (required), `Mode_Of_Payment__c`
  (Cash, Cheque, Credit/Debit Card, Internet Banking, Loan, POS-PineLabs, RazorPay, UPI),
  `Payment_Status__c` (Success, Failure, Awaited, Aborted), `Source_Of_Payment__c`
  (Website, In Person, PineLabs), `Payment_Date__c`, `Bank_Reference_Number__c`, `Tracking_Id__c`,
  refund block (`Refund_Amount__c`, `Refund_Date__c`, `Refund_Method__c`, `Refund_Status__c`,
  `Refund_Transaction_ID__c`, `Refund_Reason__c`, `Refund_Notes__c`)
- **Relationships:** none (linked to orders via Order_Payment__c)

### Order_Payment__c — "Order Payment" (JUNCTION: Order ↔ Payment)
- **Key fields:** `Amount__c`/`Amount1__c`, `Type__c` (required: Booking Amount, Down Payment,
  Refund, Warranty Payment, Accessories Payment, RSA Payment, Full payment, Others),
  `Website_Payment_Id__c`, `Mode_of_payment__c`, `Payment_Date__c`, `Booking_ids__c`,
  `Booking_Amount__c`, `Payment_Acknowledgement_Generated__c`
- **Relationships:** `Order__c`→**Order** (standard, MD?), `Payments__c`→Payment__c (MD?),
  `Log_Payment__c`→Payment_Split__c

### Order_Invoice__c — "Order Invoice"
- **Key fields:** `Invoice_Number__c` (required, sequence), `Invoice_Type__c` (Vehicle, Accessories,
  Other Charges, Add-ons, Merchandise), `Invoice_Date__c`, `Invoice_Data__c` (Valid/Invalid),
  `Vehicle_Identification_number__c`, `Dealer_Code__c`, `Preferred_seller__c`, `Month_of_Invoice__c`
- **Relationships:** `Order__c`→**Order** (standard, MD?)

### Test_Drive__c — "Test Drive"
- **Key fields:** `Ride_Type__c` (HTR=Home Test Ride, STR=Store Test Ride), `Test_Drive_Status__c`
  (New, Scheduled, In Progress, Completed, Cancelled, Reschedule), `Test_Drive_Date__c`,
  `Test_Ride_Date__c`, `Test_Drive_Completed_Date__c`, `Drivers_License_Number__c`, `Indemnity__c`,
  `Feedback__c`, `Reason_For_Cancellation__c`, `Duplicate__c`
- **Relationships:** `Lead__c`→Lead, `Opportunity__c`→Opportunity

### Asset — "Asset" (sold vehicles)
- **Key fields:** standard `SerialNumber`, `Status` (Purchased, Shipped, Installed, Registered,
  Obsolete), `InstallDate`, `PurchaseDate`, `Price`, `StockKeepingUnit`
- **Relationships:** `AccountId`→Account, `ContactId`→Contact, `Product2Id`→Product2,
  `ParentId`/`RootAssetId`→Asset, `AssetProvidedById`/`AssetServicedById`→Account

### WorkOrder — "Job Card" (standard, the service workhorse; 200+ fields)
- **Key fields:** `RR_Job_Type__c` (Paid Service, Running Repairs, Accidental, Periodic maintenance,
  VAS Purchase, Campaign, Warranty), `RR_Periodic_Maintenance_Type__c` (1st–18th Service),
  `Vehicle_Identification_Number__c`, `Vehicle_Registration_Number__c`, `Odometer_Reading__c`,
  `Invoice_No__c`/`Estimate_No__c` (required), `Insurance_Applied__c`, `Insurance_Type__c`,
  `Policy_Number__c`, `Claim_Id__c`, `Total_Amount_Paid__c`, `Labour_Charge(s)__c`,
  CGST/SGST/IGST tax fields, `Bay_Allocation__c` (L1/L2/L3), `Is_VOR__c`, aging metrics, and dozens
  of `RR_*` PDI/inspection checklist fields
- **Relationships:** `AccountId`→Account, `ContactId`→Contact, `CaseId`→Case, `AssetId`→Asset,
  `Service_Appointment__c`→ServiceAppointment, `Service_Center__c`→Account,
  `RR_Service_Advisor__c`→ServiceResource, `RR_Technician__c`/`Dealer_Contact__c`→Contact,
  `Checklist__c`→Checklist__c, `Warehouse__c`→Warehouse__c, `Inventory_Lot__c`→Inventory_Lot__c,
  `Account_Order__c`→**Order** (standard), `City__c`→City__c

### ServiceAppointment — "Service Reminder" (standard)
- **Key fields:** `Service_Type__c` (Paid Service, Running Repairs, Warranty, Accidental, Periodic
  maintenance, PDI), `Periodic_Maintenance_Type__c` (1st–18th Service), `Appointment_Date__c`,
  `RSA_Required__c`, `Spare_Vehicle__c`/`Spare_Vehicle_Status__c`, `Service_Vehicle__c`,
  `Distance_Range__c` (<300KM / >300KM), `Call_Status__c` (Pending, Wrong Number, Unable to Connect,
  Appointment Booked, Completed, NFA), `Call_Back_Count__c`, `Reschedule_Attempts__c`
- **Relationships:** `ParentRecordId`→ polymorphic (Account/Asset/Case/Lead/Opportunity/WorkOrder),
  `AccountId`→Account, `ContactId`→Contact, `Service_Centre__c`→Account,
  `Inventory_Lot__c`→Inventory_Lot__c

### Subscription__c — "Subscription" (service/care plans)
- **Key fields:** `Start_Date__c`, `End_Date__c`, `Total_Instances__c`, `Availed_Instances__c`,
  `Remaining_Instances__c`, `Status__c` (Active, Expired, Cancelled, Pending), `Source__c`
- **Relationships:** `Subscription_Product__c`→Subscription_Product__c, `Account__c`→Account,
  `Customer_Contact__c`→Contact

### Subscription_Instance__c — "Subscription Instance" (JUNCTION: Subscription ↔ WorkOrder)
- **Key fields:** `Service_Date__c`, `Status__c` (Availed, Cancelled, Pending)
- **Relationships:** `Subscription__c`→Subscription__c, `Job_Card__c`→WorkOrder

### Customer_Concern__c — "Customer Concern" (child of Case)
- **Key fields:** `Type__c` (General Query, Complaint, Urgent Complaint, Service Request,
  PSFU Concerns), `Department__c` (Sales, Service, Merchandise, Accessories), `Case_Category__c` /
  `Case_Category_Update__c` (CRM binning), `Concerns__c` (vehicle-component taxonomy),
  `Subconcerns__c` (detailed fault taxonomy), `VOC__c` (Voice of Customer), `Closed_Resolution__c`
- **Relationships:** `Case__c`→Case (MD?)

### TFR__c — "VIN Cut off" (field/quality reporting by VIN range)
- **Key fields:** `VIN_Start__c`, `Sample_Size__c`, `Collected_Sample__c`, `Report_Status__c`
  (Open, In Review, Closed, Sample Collected), `Reported_Date__c`, `Error_Code__c`, `Bug_ID__c`,
  `Is_Active__c`, `Description__c`
- **Relationships:** none

### Reference / master objects
- **Pre_Delivery_Inspection__c** — PDI checklist template (`Attribute__c`, `Parameter__c`, `Description__c`)
- **Insurance__c** — insurer master (`Insurer_Code__c`, `GSTIN_Number__c`, `Address__c`)
- **Finance__c** — finance provider master (`Finance_Code__c`)
- **Manufacturer_Unit__c** — plant master (`Address__c`)
- **City__c** / **Pin_Code__c** — geography reference

---

## 6. Relationship map (core flow)

```
Lead ──(convert)──► Account ◄──► Contact
  │                   │  ▲           │
  └─► Test_Drive__c   │  └─self-ref (Service_Center__c, ParentId)
                      │
   Account ──► Order (standard) ──► OrderItem
                      │  ▲
                      │  ├── Order_Payment__c ──► Payment__c   (Order ↔ Payment junction)
                      │  ├── Order_Invoice__c
                      │  └── WorkOrder.Account_Order__c
                      │
   Account ──► Asset (vehicle) ──► Product2
                      │
   WorkOrder ("Job Card") ──► Account, Contact, Case, Asset, ServiceAppointment, Service_Center
        ▲
   Subscription__c ──► Subscription_Instance__c ──► WorkOrder
        │
   Case ──► Customer_Concern__c
```

---

## 7. Suggested next steps for development

- **Confirm MD vs Lookup** in Setup for the `MD?` relationships before writing triggers/flows that
  rely on cascade delete or roll-up summaries.
- **Standardize on the standard `Order`** object; treat custom `Order__c` as legacy unless a specific
  requirement says otherwise.
- **Load representative test data** into the empty transactional objects (Cases, WorkOrders,
  ServiceAppointments, Subscriptions) before building/testing service flows — they're built but empty.
- **Integration credentials** live in singleton custom objects (SAP, ClearTax, PineLabs, RSA,
  Website, WhatsApp). Review/rotate these and avoid hardcoding; they're environment-specific.
- **Don't edit managed-package objects** (`et4ae5__*`, `omnistudio__*`, `Calendly__*`) directly.

---

*Generated from a live describe of the `rrdev` sandbox. Record counts are a point-in-time snapshot
(2026-06-09) and will change as data is loaded.*
