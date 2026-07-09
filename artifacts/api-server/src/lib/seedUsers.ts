import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { appUsersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const DEFAULT_PASSWORD = "Vtpl@2026";

const ADMIN_EMAILS = new Set([
  "nishantj@vijaytransmission.com",
  "ashokp@vijaytransmission.com",
]);

// Full user list from the company directory (display name, email)
const ALL_USERS: [string | null, string][] = [
  ["abhijeetk", "abhijeetk@vijaytransmission.com"],
  ["Abhishek Gad", "abhishekg@vijaytransmission.com"],
  ["abhishekd", "abhishekd@vijaytransmission.com"],
  ["accounts 1", "accounts1@vijaytransmission.com"],
  ["accounts 2", "accounts2@vijaytransmission.com"],
  ["admin vijaytransmission", "admin@vijaytransmission.com"],
  ["alok paliwal", "alokp@vijaytransmission.com"],
  ["anjanikumar nigam", "aknigam@vijaytransmission.com"],
  ["Arvind Yadav", "arvindy@vijaytransmission.com"],
  ["ashokp", "ashokp@vijaytransmission.com"],
  ["benis", "benis@vijaytransmission.com"],
  ["bhaskarm", "bhaskarm@vijaytransmission.com"],
  ["Bunty das", "buntys@vijaytransmission.com"],
  ["collection vijaytransmission", "collection@vijaytransmission.com"],
  ["design mumbai", "designmum@vijaytransmission.com"],
  ["dev baghel", "devb@vijaytransmission.com"],
  ["Digambar Singh", "digambars@vijaytransmission.com"],
  ["Dispatch dispatch", "dispatch@vijaytransmission.com"],
  ["engineering", "engineering@vijaytransmission.com"],
  ["Export @ VTPL", "export@vijaytransmission.com"],
  ["fabrication", "fabrication@vijaytransmission.com"],
  ["gdpc", "gpqc@vijaytransmission.com"],
  ["GENDLAL RATHOR", "info@vijaytransmission.com"],
  ["gulshan varma", "gulshanv@vijaytransmission.com"],
  ["hr", "hr@vijaytransmission.com"],
  ["jitendrav", "jitendrav@vijaytransmission.com"],
  ["kntiwari", "kntiwari@vijaytransmission.com"],
  ["Koushalram Sahu", "koushals@vijaytransmission.com"],
  ["marketing team", "marketing@vijaytransmission.com"],
  ["metal park", "metalpark@vijaytransmission.com"],
  ["mohammad iqbal akhtar", "makhtar@vijaytransmission.com"],
  ["mukeshy", "mukeshy@vijaytransmission.com"],
  ["naresh sahu", "nareshs@vijaytransmission.com"],
  ["Ncpaliwal paliwal", "ncpaliwal@vijaytransmission.com"],
  ["neelam", "neelamn@vijaytransmission.com"],
  ["Prince Singh", "princesingh@vijaytransmission.com"],
  ["purchase account", "purchase@vijaytransmission.com"],
  ["quality", "quality@vijaytransmission.com"],
  ["rajesh nr", "rajeshnr@vijaytransmission.com"],
  ["Rajus sharma", "rajus@vijaytransmission.com"],
  ["rakesh", "rakeshb@vijaytransmission.com"],
  ["ram yadav", "ramyadav@vijaytransmission.com"],
  ["Rashidm mansuri", "rashidm@vijaytransmission.com"],
  ["richa paliwal", "richap@vijaytransmission.com"],
  ["Rparshuraman raman", "rparshuraman@vijaytransmission.com"],
  ["safety", "safety@vijaytransmission.com"],
  ["sales sales", "sales@vijaytransmission.com"],
  ["Sambit Mohapatra", "sambitm@vijaytransmission.com"],
  ["Sanjay Paliwal", "sanjayp@vijaytransmission.com"],
  ["sanjays", "sanjays@vijaytransmission.com"],
  ["shastrik", "shastrik@vijaytransmission.com"],
  ["shivamy yadav", "shivamy@vijaytransmission.com"],
  ["Shivangi Tiwari", "shivangit@vijaytransmission.com"],
  ["shivank garg", "shivankg@vijaytransmission.com"],
  ["shubham tiwari", "shubhamt@vijaytransmission.com"],
  ["store store", "store@vijaytransmission.com"],
  ["sundar subramaniam", "sundars@vijaytransmission.com"],
  ["sunilc", "sunilc@vijaytransmission.com"],
  ["umesh", "umeshp@vijaytransmission.com"],
  ["varun paliwal", "varunp@vijaytransmission.com"],
  ["Vijay Singh", "vijays@vijaytransmission.com"],
  ["vipinj", "vipinj@vijaytransmission.com"],
  ["nidhi yadav", "nidhiy@vijaytransmission.com"],
  ["tender", "tenders@vijaytransmission.com"],
  ["finance", "finance@vijaytransmission.com"],
  ["tax", "tax@vijaytransmission.com"],
  ["gst", "gst@vijaytransmission.com"],
  ["chitransupanda", "chitransup@vijaytransmission.com"],
  ["Nishant jain", "nishantj@vijaytransmission.com"],
  ["AI Tools", "ai-tools@vijaytransmission.com"],
  ["AI TEAM", "ai-team@vijaytransmission.com"],
  ["ai", "ai@vijaytransmission.com"],
  ["Sangita sahu", "sangitas@vijaytransmission.com"],
  ["nischal jain", "nischalj@vijaytransmission.com"],
  ["anitesh gupta", "aniteshg@vijaytransmission.com"],
  ["ravi varma", "ravi@vijaytransmission.com"],
  ["admin", "microsoft@vijaytransmission.com"],
  ["sarjo", "sarojs@vijaytransmission.com"],
];

export async function seedUsersIfEmpty(): Promise<void> {
  try {
    const count = await db
      .select({ n: sql<number>`count(*)` })
      .from(appUsersTable);
    const existing = Number(count[0]?.n ?? 0);
    if (existing > 0) {
      logger.info({ existing }, "Users already seeded, skipping");
      return;
    }

    logger.info("Seeding users from company directory...");
    // Hash once and reuse — all users start with the same default password.
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    const values = ALL_USERS.map(([displayName, email]) => ({
      email,
      displayName,
      passwordHash,
      role: ADMIN_EMAILS.has(email) ? "admin" : "user",
      mustChangePassword: true,
    }));

    await db.insert(appUsersTable).values(values).onConflictDoNothing();
    logger.info({ count: values.length }, "Users seeded successfully");
  } catch (err) {
    logger.error({ err }, "Failed to seed users");
  }
}
