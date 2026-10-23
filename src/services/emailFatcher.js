import xlsx from "xlsx";

import {
  getTodaysEMail,
  getEmailAttachments,
  markEmailAsRead,
} from "../workers/emailWorker.js";

import { createShipment } from "./trackingService.js";

const isEmpty = (value) => {
  if (value === undefined || value === null) {
    return true;
  }

  return String(value).trim() === "";
};

const cleanPO = (value) => {
  if (isEmpty(value)) {
    return "";
  }

  return String(value).trim();
};

const cleanTracking = (value) => {
  if (isEmpty(value)) {
    return "";
  }

  return String(value).trim().replace(/^'/, "").trim();
};

const normalizeCell = (value) => {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
};

const isValidTracking = (trackingNo) => {
  if (!trackingNo) {
    return false;
  }

  const cleaned = trackingNo.replace(/[\s-]/g, "");

  if (cleaned.length < 10) {
    return false;
  }

  if (!/^(1Z[A-Z0-9]{16}|[A-Z0-9]+)$/i.test(cleaned)) {
    return false;
  }

  return true;
};

const isValidPO = (poNumber) => {
  if (!poNumber) {
    return false;
  }

  const invalidValues = ["packlist"];

  if (invalidValues.includes(poNumber.toLowerCase())) {
    return false;
  }

  return true;
};

export const GetData = async (company) => {
  if (!company?.email) {
    throw new Error(`No mailbox configured for ${company?.name || "company"}`);
  }
  const mailbox = company.email;
  try {
    if (!mailbox) {
      console.log("No mailbox provided");
      return;
    }
    const emails = await getTodaysEMail(company);

    if (!emails.length) {
      console.log("No new emails found");
      return;
    }

    for (const email of emails) {
      try {
        console.log("--------------------------------");
        console.log("Processing email...");

        console.log("Sender:", email.from?.emailAddress?.address);

        if (!email.hasAttachments) {
          console.log("No attachment found");

          await markEmailAsRead(company, email.id);

          continue;
        }

        const attachments = await getEmailAttachments(company, email.id);

        console.log(`Found ${attachments.length} attachment(s)`);

        let processedExcel = false;

        for (const attachment of attachments) {
          console.log("Attachment:", attachment.name);

          const filename = attachment.name?.toLowerCase() || "";

          if (
            !filename.endsWith(".xlsx") &&
            !filename.endsWith(".xls") &&
            !filename.endsWith(".csv")
          ) {
            console.log("Not an Excel/CSV file. Skipping.");

            continue;
          }

          processedExcel = true;

          if (!attachment.contentBytes) {
            console.log("Attachment does not contain contentBytes");

            continue;
          }

          const buffer = Buffer.from(attachment.contentBytes, "base64");

          const workbook = xlsx.read(buffer, {
            type: "buffer",
          });

          if (!workbook.SheetNames.length) {
            console.log("Excel file has no sheets");
            continue;
          }

          const sheetName = workbook.SheetNames[0];

          console.log("Sheet:", sheetName);

          const worksheet = workbook.Sheets[sheetName];

          const rows = xlsx.utils.sheet_to_json(worksheet, {
            header: 1,
            defval: "",
            raw: false,
          });

          if (!rows.length) {
            console.log("Excel sheet is empty");
            continue;
          }

          // ==========================================
          // FIND PO / TRACKING HEADER
          // ==========================================

          const headerIndex = rows.findIndex((row) => {
            if (!Array.isArray(row)) {
              return false;
            }

            return (
              row.some((cell) => normalizeCell(cell) === "po") &&
              row.some((cell) => normalizeCell(cell) === "tracking")
            );
          });

          if (headerIndex === -1) {
            console.log("Could not find PO / Tracking header row");

            continue;
          }

          const headers = rows[headerIndex];

          const POIndex = headers.findIndex(
            (cell) => normalizeCell(cell) === "po",
          );

          const trackingIndex = headers.findIndex(
            (cell) => normalizeCell(cell) === "tracking",
          );

          if (POIndex === -1 || trackingIndex === -1) {
            console.log("PO or Tracking column not found");

            continue;
          }

          const lineNoIndex = 4;
          const itemIndex = 5;
          const descIndex = 6;
          const qtyOrdIndex = 7;
          const shpIndex = 8;
          const boIndex = 9;

          const shipments = [];

          let currentShipment = null;
          let readingLineItems = false;

          let invalidRows = 0;
          let missingPO = 0;
          let missingTracking = 0;

          for (let i = headerIndex + 1; i < rows.length; i++) {
            const row = rows[i];

            if (!Array.isArray(row)) {
              continue;
            }

            const poNumber = cleanPO(row[POIndex]);

            const trackingNo = cleanTracking(row[trackingIndex]);

            const isShipmentRow =
              isValidPO(poNumber) && isValidTracking(trackingNo);

            if (isShipmentRow) {
              currentShipment = {
                poNumber,
                trackingNo,
                lineItems: [],
              };

              shipments.push(currentShipment);

              readingLineItems = false;

              continue;
            }

            if (currentShipment) {
              const rowValues = row.map(normalizeCell);

              const hasLn = rowValues.includes("ln");

              if (hasLn) {
                readingLineItems = true;

                continue;
              }
            }

            if (currentShipment && readingLineItems) {
              const lineNo = row[lineNoIndex];

              const itemCode = row[itemIndex];

              const description = row[descIndex];

              const qtyOrdered = row[qtyOrdIndex];

              const qtyShipped = row[shpIndex];

              const BO = row[boIndex];

              if (
                isEmpty(lineNo) &&
                isEmpty(itemCode) &&
                isEmpty(description)
              ) {
                readingLineItems = false;

                continue;
              }

              if (isEmpty(lineNo) || isEmpty(itemCode)) {
                continue;
              }

              const lineItem = {
                lineNo: Number(lineNo) || null,

                itemCode: String(itemCode).trim(),

                description: String(description || "").trim(),

                qtyOrdered: Number(qtyOrdered) || 0,

                qtyShipped: Number(qtyShipped) || 0,

                BO: Number(BO) || 0,
              };

              currentShipment.lineItems.push(lineItem);

              continue;
            }

            if (!isEmpty(poNumber) && !isValidPO(poNumber)) {
              currentShipment = null;
              readingLineItems = false;
              invalidRows++;
              continue;
            }

            if (!isEmpty(trackingNo) && !isValidTracking(trackingNo)) {
              currentShipment = null;
              readingLineItems = false;
              invalidRows++;
              continue;
            }

            if (!isEmpty(poNumber) && isEmpty(trackingNo)) {
              missingTracking++;
              currentShipment = null;
              readingLineItems = false;
              console.log(
                `Missing Tracking - Excel row ${i + 1} | PO: ${poNumber}`,
              );

              continue;
            }

            if (isEmpty(poNumber) && !isEmpty(trackingNo)) {
              currentShipment = null;
              readingLineItems = false;
              missingPO++;

              console.log(
                `Missing PO - Excel row ${i + 1} | Tracking: ${trackingNo}`,
              );

              continue;
            }
          }

          console.log("");

          console.log("==========================================");

          console.log("VALID SHIPMENTS FOUND");

          console.log("==========================================");

          shipments.forEach(({ poNumber, trackingNo, lineItems }, index) => {
            console.log(
              `${index + 1}. PO: ${poNumber} | Tracking: ${trackingNo}`,
            );

            console.log(`   Line Items: ${lineItems.length}`);

            lineItems.forEach((item) => {
              console.log(
                `   ${item.lineNo}. ${item.itemCode} | ${item.description} | Ordered: ${item.qtyOrdered} | Shipped: ${item.qtyShipped} | BO: ${item.BO}`,
              );
            });
          });

          const totalLineItems = shipments.reduce(
            (total, shipment) => total + shipment.lineItems.length,
            0,
          );

          console.log("");

          console.log("==========================================");

          console.log("SHIPMENT TOTALS");

          console.log("==========================================");

          console.log(`Total valid shipments: ${shipments.length}`);

          console.log(`Total line items: ${totalLineItems}`);

          console.log(`Missing PO: ${missingPO}`);

          console.log(`Missing Tracking: ${missingTracking}`);

          console.log(`Invalid rows: ${invalidRows}`);

          console.log("==========================================");

          for (const shipment of shipments) {
            const { poNumber, trackingNo, lineItems } = shipment;

            try {
              const createdShipment = await createShipment(
                poNumber,
                trackingNo,
                lineItems,
                company.name,
              );
            } catch (error) {
              console.error(
                `Failed for PO=${poNumber} | Tracking=${trackingNo}:`,
                error.message,
              );
            }
          }
        }

        if (processedExcel) {
          await markEmailAsRead(company, email.id);

          console.log("Email marked as read");
        }
      } catch (error) {
        console.error("Error processing email:", error.message);
      }
    }
  } catch (error) {
    console.error("Microsoft Graph email error:", error);
  }
};
