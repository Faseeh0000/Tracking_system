import { getGraphClient } from "../config/graphClient.js";

// const mailbox = process.env.MICROSOFT_EMAIL;

export const getTodaysEMail = async (company) => {
  const graphClient = getGraphClient(company);
  const mailbox = company.email;

  const allowedSenders = (process.env.ALLOWED_SENDERS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedSenders.length) {
    throw new Error("ALLOWED_SENDERS is not configured in .env file");
  }

  const senderFilter = allowedSenders
    .map((email) => `from/emailAddress/address eq '${email}'`)
    .join(" or ");

  const now = new Date();

  const pakistanDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const startOfTodayPKT = new Date(`${pakistanDate}T00:00:00+05:00`);

  const filter = `
    receivedDateTime ge ${startOfTodayPKT.toISOString()}
    and (${senderFilter})
  `
    .replace(/\s+/g, " ")
    .trim();

  console.log("Pakistan date:", pakistanDate);
  console.log("Searching emails from:", startOfTodayPKT.toISOString());

  const response = await graphClient
    .api(`/users/${mailbox}/mailFolders/inbox/messages`)
    .filter(filter)
    .select("id,subject,from,receivedDateTime,hasAttachments,isRead")
    .top(50)
    .get();

  const emails = response.value || [];

  emails.sort(
    (a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime),
  );

  console.log(`Found ${emails.length} email(s) from today`);

  return emails;
};

export const getEmailAttachments = async (company, messageId) => {
  const graphClient = getGraphClient(company);
  const mailbox = company.email;
  const response = await graphClient
    .api(`/users/${mailbox}/messages/${messageId}/attachments`)
    .get();

  return response.value;
};

export const markEmailAsRead = async (company, messageId) => {
  const graphClient = getGraphClient(company);
  const mailbox = company.email;

  await graphClient.api(`/users/${mailbox}/messages/${messageId}`).update({
    isRead: true,
  });
};
