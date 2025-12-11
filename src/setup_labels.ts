import { BskyAgent } from "@atproto/api";
import dotenv from "dotenv";

dotenv.config();

const BSKY_HANDLE = process.env.BSKY_HANDLE!;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD!;

const LABELS = [
  {
    identifier: "explicit-niko-artist",
    severity: "warn",
    blurs: "media",
    defaultSetting: "warn",
    adultOnly: false,
    locales: [
      {
        lang: "en",
        name: "Explicit Niko Artist",
        description: "An account that regularly creates or shares explicit or sexually suggestive Niko (OneShot) artwork.",
      },
    ],
  },
  {
    identifier: "engages-explicit-niko",
    severity: "inform",
    blurs: "none",
    defaultSetting: "warn",
    adultOnly: false,
    locales: [
      {
        lang: "en",
        name: "Engages With Explicit Niko Content",
        description: "An account that frequently interacts (likes, reposts or comments) with explicit or sexually suggestive Niko (OneShot) artwork or its creators.",
      },
    ],
  },
  {
    identifier: "follows-explicit-niko",
    severity: "inform",
    blurs: "none",
    defaultSetting: "warn",
    adultOnly: false,
    locales: [
      {
        lang: "en",
        name: "Follows Explicit Niko Artist",
        description: "An account that follows one or more creators who post explicit or sexually suggestive Niko (OneShot) artwork. **Following does not imply endorsement.**",
      },
    ],
  },
];

async function main() {
  const agent = new BskyAgent({ service: "https://bsky.social" });

  try {
    await agent.login({
      identifier: BSKY_HANDLE,
      password: BSKY_PASSWORD,
    });
    console.log("Logged in.");

    // Fetch current labeler service record
    const { data: { did } } = await agent.resolveHandle({ handle: BSKY_HANDLE });
    
    // We need to find the 'app.bsky.labeler.service' record.
    // Usually it's at 'self' rkey or we list them.
    const records = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: "app.bsky.labeler.service",
    });

    if (records.data.records.length === 0) {
      console.error("No labeler service record found. Please run 'npx @skyware/labeler setup' first to initialize the labeler.");
      return;
    }

    const record = records.data.records[0];
    const rkey = record.uri.split("/").pop()!;
    const currentValue = record.value as any;

    console.log("Found labeler record:", record.uri);

    // Update policies
    const newPolicies = {
      ...currentValue.policies,
      labelValues: [
        ...(currentValue.policies?.labelValues || []),
        ...LABELS.map(l => l.identifier)
      ].filter((v, i, a) => a.indexOf(v) === i), // unique
      labelValueDefinitions: [
        ...(currentValue.policies?.labelValueDefinitions || []).filter((d: any) => !LABELS.find(l => l.identifier === d.identifier)), // remove existing if we are updating
        ...LABELS
      ]
    };

    // Put the updated record
    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: "app.bsky.labeler.service",
      rkey: rkey,
      record: {
        ...currentValue,
        policies: newPolicies,
      },
    });

    console.log("Successfully updated label definitions!");
    console.log("Added/Updated labels:");
    LABELS.forEach(l => console.log(`- ${l.identifier}`));

  } catch (e) {
    console.error("Error updating labels:", e);
  }
}

main();
