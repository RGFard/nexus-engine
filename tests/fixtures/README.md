# Source payload samples

One sample payload per source system. There are no written schemas for
these systems. nexus-engine infers the source shape from each payload it
receives, so these files are the only record of what each system sends.

| System | File | Shape |
|---|---|---|
| UPS | `ups-shipment.json` | `ShipFrom`, `ShipTo`, `Package`, `Service` |
| FedEx | `fedex-shipment.json` | `shipper`, `recipient`, `requestedPackageLineItems[]` |
| FedEx (response) | `fedex-transaction-response.json` | `output` wrapper from a create-shipment response |
| DHL (international) | `dhl-international-shipment.json` | `Shipper`, `Recipient`, `Packages.RequestedPackages[]`, `InternationalDetail` |
| DHL (domestic) | `dhl-shipment.json` | `senderDetails`, `receiverDetails`, `packages[]`, `productCode` |
| EasyPost | `easypost-shipment.json` | `from_address`, `to_address`, `parcel` |
| ShipStation | `shipstation-shipment.json` | `shipTo`, `billTo`, `advancedOptions.warehouseId`, no ship-from address |
| ERP (SAP flat) | `erp-shipment.json` | flat, all-caps SAP field codes |
| Generic | `shipto-billto-shipment.json` | `shipFrom`, `shipTo`, `billTo` |
| Canonical | `canonical-shipment.json` | what the engine produces from `dhl-international-shipment.json`; input for the outbound plan test |

## SAP field codes in the ERP sample

| Code | Meaning |
|---|---|
| `NTGEW` | net weight |
| `GEWEI` | weight unit |
| `LFIMG` | delivered quantity |
| `ARKTX` | item description |
| `MATNR` | material number (SKU) |
| `STRAS_S`, `ORT01_S`, `LAND1_S`, `NAME1_S` | sender street, city, country, name |
| `STRAS_E`, `ORT01_E`, `LAND1_E`, `NAME1_E` | receiver street, city, country, name |

## Notes

- `erp-shipment.json` and `easypost-shipment.json` are copies of the
  payloads typed inline in `custom-vocabulary.test.ts` and
  `learned-vocabulary.test.ts`. Those tests still use their inline copies.
- Both are small samples. The richer payloads used in manual testing
  (ERP with `PSTLZ_E`, `TELF1_E`, `BRGEW`, `ERDAT`; EasyPost with a
  `shipment` wrapper) were sent from Postman and are not in this folder.
- The outbound DHL target schema is in
  `src/target-schemas/dhl/shipment-create-request.schema.json`. It follows
  the shape of `dhl-international-shipment.json`.
