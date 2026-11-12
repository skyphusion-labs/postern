// #813 recall eval: a DETERMINISTIC generated mailbox and a fixed query set with gold ids.
// Synthetic and obviously fake (example.com / example domains only). Same seed, same
// corpus, byte for byte, so a before/after table compares like with like.
//
// Families of mail:
//   - templated notifications that differ only in a hash, an id or a number
//     (CI run failures per job, PR check failures, order shipped, sign-in alerts);
//   - short human mail whose subject carries the meaning;
//   - longer human threads (3 messages each) on distinct topics.
// Query families (gold = the message ids that answer it):
//   token     known item by its distinguishing token (commit hash, order number, PR number)
//   latest    the exact shared subject of a templated family; gold = its NEWEST member
//   subject   known item by the exact subject of a short human mail
//   paraphrase  a reworded question about a thread or a short mail (gold = any message of it)
//   diversity   a broad question several families answer; scored as family coverage at 10

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ME = "alex@team.example";
const JOBS = ["corpus-sync", "nightly-index", "deploy-staging"];
const STEPS = ["fetch", "build", "test", "upload", "migrate"];
const ITEMS = ["walnut desk lamp", "wool hiking socks", "cast iron skillet", "noise cancelling headphones", "bamboo cutting board", "stainless water bottle"];
const CARRIERS = ["UPS", "FedEx", "DHL"];
const CITIES = ["Lisbon", "Denver", "Osaka", "Toronto", "Nairobi"];
const DEVICES = ["Firefox on Linux", "Safari on iPhone", "Chrome on Windows"];

// Short human mail: [subject, body, paraphrase query]
const SHORT = [
  ["Dentist appointment moved to Thursday", "They called, it is now 3pm Thursday.", "when is my dental visit now"],
  ["Lunch on Friday?", "Thai place near the office, noon?", "plans to eat midday at the end of the week"],
  ["Spare key is under the blue pot", "In case you get home before me.", "where did you leave the extra house key"],
  ["Parking pass expires end of month", "Renew it at the front desk.", "when does my car permit run out"],
  ["Book club picks The Overstory", "Next meeting is the 14th.", "which novel is the reading group doing"],
  ["Gym closed for repairs on Monday", "Pool too.", "is the fitness center open at the start of the week"],
  ["Recipe for the lentil soup", "Cumin, carrots, red lentils, lemon at the end.", "how do you make that bean stew"],
  ["Flight lands at 6:40", "Terminal 2, I will text from the gate.", "what time does the plane arrive"],
  ["Vet says Biscuit is fine", "Just needs the ear drops twice a day.", "update on the dog after the animal doctor"],
  ["Wifi password changed", "New one is on the fridge.", "router login is different now"],
  ["Can you water the plants Saturday", "Ferns twice, cactus once.", "help with watering greenery this weekend"],
  ["Tickets for the jazz night", "Row F, seats 12 and 13.", "seats for the music concert"],
  ["Car inspection booked", "Wednesday 8am at the garage on Elm.", "when is the vehicle check"],
  ["Mom's birthday dinner", "Saturday at 7, she wants Italian.", "family celebration meal plans"],
  ["Return the library books", "Due tomorrow, three of them.", "overdue borrowed reading material"],
  ["New hire starts Monday", "Priya, backend, please set up her laptop.", "a new colleague is joining the team"],
  ["Quarterly taxes due on the 15th", "Estimated payment, the form is in the folder.", "deadline for the IRS payment"],
  ["Roof leak in the attic", "Bucket is under it, roofer comes Friday.", "water coming through the ceiling upstairs"],
  ["Kids pickup swap this week", "I take Tuesday, you take Thursday.", "trading school collection days"],
  ["Electric bill went up a lot", "Probably the space heater.", "why is the power invoice higher"],
  ["Passport renewal photos", "Need two, plain white background.", "pictures for the travel document"],
  ["Conference talk accepted", "Slot is day two, 30 minutes.", "my presentation proposal was approved"],
  ["Laptop battery swelling", "Stop using it, IT is sending a replacement.", "computer battery is bulging"],
  ["Coffee machine descaling", "Run the cycle with vinegar tonight.", "cleaning the espresso maker"],
  ["Neighbors party noise complaint", "Building manager will talk to them.", "the people next door were too loud"],
];

// Longer threads: [subject, [three bodies], paraphrase]
const THREADS = [
  ["Office move to the Harbor building", ["We move to the Harbor building on March 3. Pack your desks by the 28th.", "Will the movers take monitors or do we carry them?", "Movers take everything, label each box with your name."], "when are we relocating to the new office"],
  ["Budget review for the analytics team", ["The analytics budget is 12 percent over for the quarter, mostly cloud spend.", "Can we shift the warehouse jobs to off-peak pricing?", "Yes, that saves about a third of the overage."], "why is the data group spending too much"],
  ["Customer churn in the EU region", ["Churn in the EU went up after the price change in September.", "Exit surveys mention invoicing in euros, not the price itself.", "Then billing in local currency is the first fix."], "why are european customers cancelling"],
  ["Hiring plan for the platform team", ["We can open two platform engineer roles in Q1.", "Should one be senior to lead the on-call rotation?", "Agreed, one senior and one mid level."], "how many people will we recruit for infrastructure"],
  ["Postmortem for the login outage", ["Login failed for 40 minutes because a certificate expired.", "Why did the expiry alert not fire?", "The alert pointed at the old load balancer. Fixed now."], "what caused people to be unable to sign in"],
  ["Holiday rota for December", ["Please add your December days off to the shared sheet.", "I can cover the week between the holidays.", "Thanks, that leaves only the 24th uncovered."], "who is working over the end of year break"],
  ["Migrating the database to Postgres 17", ["The Postgres 17 upgrade needs a maintenance window of two hours.", "Can we do it Sunday early morning?", "Sunday 5am works, I will post the notice."], "planning the sql server version upgrade"],
  ["Design review for the onboarding flow", ["New onboarding cuts the signup form from nine fields to four.", "Do we still collect the company size?", "Later, on the second screen, optional."], "feedback on the new user registration screens"],
  ["Vendor contract renewal for the CDN", ["The CDN contract renews in 60 days at a 15 percent increase.", "Have we priced the alternatives?", "Two quotes are in, both cheaper with similar traffic limits."], "renegotiating the content delivery agreement"],
  ["Security training is mandatory", ["Everyone must finish the phishing training by Friday.", "Is there a version with captions?", "Yes, the captioned version is linked in the portal."], "required course about suspicious emails"],
  ["Team offsite in Porto", ["The offsite is in Porto, May 12 to 14.", "Is the hotel within walking distance of the venue?", "Ten minutes on foot along the river."], "where is the company retreat"],
  ["Flaky test in the payments suite", ["The refund test fails one run in twenty on CI.", "It looks timing dependent, the clock is not mocked.", "Mocked the clock, it passed 500 runs in a row."], "intermittent failure in the billing tests"],
  ["Pricing page redesign", ["Marketing wants three tiers instead of four on the pricing page.", "Which tier do we drop?", "We merge Starter and Basic."], "simplifying how plans are shown to buyers"],
  ["Laptop refresh for engineering", ["Engineering laptops older than four years will be replaced in April.", "Can we choose between models?", "Two models, both with 32 GB of memory."], "new computers for the developers"],
  ["Data retention policy update", ["Logs will be kept for 90 days instead of a year.", "Does that include audit logs?", "No, audit logs stay for seven years."], "how long do we store records now"],
];

// #930: a second block, APPENDED with its own seed so the first 300 messages and 98
// queries stay byte-identical. It adds five more notification families (for hybrid
// diversity), twenty more threads (so thread collapse, #926, is judged on more than 15),
// and broad queries that several families answer.
const THREADS2 = [
  ["Quarterly planning for the mobile app", ["Mobile planning: offline mode and push settings are the two big items.", "Offline mode first, push settings can slip to Q3.", "Agreed, offline mode is the Q2 headline."], "what is the phone app roadmap for next quarter"],
  ["Expense policy for client dinners", ["Client dinners are capped at 80 dollars a head from next month.", "Does the cap include wine?", "Yes, everything on the bill counts."], "limit on spending when taking customers out to eat"],
  ["Accessibility audit results", ["The audit found 14 issues, mostly missing labels on form fields.", "Can we fix the labels this sprint?", "Labels this sprint, contrast fixes next sprint."], "findings from the screen reader review"],
  ["Moving the standup to 9:30", ["Several people asked to move standup from 9:00 to 9:30.", "9:30 clashes with the support handover.", "Then 9:45, after the handover."], "changing the time of the morning team meeting"],
  ["Choosing a new password manager", ["We need to replace the password manager before the license lapses.", "The two finalists both support shared vaults.", "Pick the one with hardware key support."], "selecting a tool to store team credentials"],
  ["Warehouse temperature alarms", ["The cold room alarm fired three nights in a row.", "The sensor battery was low, it reads wrong when weak.", "Swapped the battery, no alarm last night."], "why did the fridge alert keep going off"],
  ["Interns for the summer", ["We have budget for three summer interns in research.", "Can one sit with the design team?", "Yes, two in research and one in design."], "how many students are joining for the holidays"],
  ["Rewriting the export feature", ["The CSV export times out on accounts with over a million rows.", "Should we stream it instead of building the file in memory?", "Streaming it, and email a link when it is ready."], "the spreadsheet download is too slow for big customers"],
  ["Office plants and cleaning rota", ["Who waters the plants now that Dana has left?", "We can add it to the cleaning rota.", "Added, it rotates weekly with the kitchen duty."], "who takes care of the greenery at work"],
  ["Customer advisory board meeting", ["The advisory board meets on the 18th, six customers confirmed.", "Do we share the roadmap slides with them?", "Only the next two quarters, under NDA."], "the session with our key clients to get product feedback"],
  ["Renewing the domain names", ["Three of our domains expire next month.", "Is auto renew on for all of them?", "It was off for one, I turned it on."], "website addresses about to lapse"],
  ["Load testing before the launch", ["Load tests show the API holds 2000 requests a second.", "What about the search endpoint?", "Search tops out at 400, we are adding a cache."], "can the system handle the traffic at launch"],
  ["Rebranding the newsletter", ["Marketing wants to rename the newsletter to The Ledger.", "Does that need a new sending domain?", "No, same domain, new display name."], "new name for our email bulletin"],
  ["Parental leave coverage", ["Jo starts parental leave in June for four months.", "Who covers the billing integrations?", "Sam covers billing, Lee takes the on call slot."], "who handles the work while a colleague is away with a new baby"],
  ["Translating the help center", ["We will translate the help center into Spanish and German first.", "Machine translation or agency?", "Agency for the top 50 articles, machine for the rest."], "localizing support articles into other languages"],
  ["Desk booking system", ["Hot desks can now be booked a week ahead in the app.", "Can we book a whole team table?", "Yes, up to eight seats in one booking."], "reserving a workspace in the office"],
  ["Incident drill next Tuesday", ["We run a failover drill next Tuesday at 2pm.", "Will customers notice anything?", "No, it runs against the staging region only."], "practice run for a disaster recovery scenario"],
  ["Fixing the flaky email delivery", ["About 2 percent of password reset emails never arrive.", "They all go to one mail provider, it greylists us.", "Retrying after the greylist delay fixed it."], "why are some account recovery messages missing"],
  ["Coffee machine budget", ["The office coffee machine broke again.", "Is it worth repairing or buying a new one?", "A new one is cheaper than two more repairs."], "replacing the broken espresso maker at work"],
  ["Board deck for March", ["The March board deck needs revenue, churn and hiring slides.", "I can do the hiring slide by Friday.", "Revenue and churn are done, deck goes out Monday."], "preparing the slides for the investors meeting"],
];

function extendCorpus(messages, queries) {
  const rnd = mulberry32(930);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const base = Date.UTC(2026, 9, 1);
  let tick = 0;
  const nextDate = () => new Date(base + (tick++) * 3_600_000 * 5).toISOString();
  const add = (m) => (messages.push({ to: ME, inReplyTo: null, ...m }), m.id);
  const FAMS = [
    ["invoice", "billing@vendor.example", () => `Invoice ${String(Math.floor(1000 + rnd() * 8999))} is available`, () => `Your invoice for ${pick(["October", "November", "September"])} is ready. Amount due ${Math.floor(20 + rnd() * 400)}.00 USD. Pay by the ${Math.floor(1 + rnd() * 28)}th. Ref ${hex(8)}.`],
    ["calendar", "calendar@meet.example", () => `Reminder: ${pick(["Design sync", "1:1 with Priya", "Budget review", "Sprint planning"])} tomorrow`, () => `This is a reminder for your meeting tomorrow at ${Math.floor(8 + rnd() * 9)}:00 in room ${pick(["Atlas", "Borealis", "Cedar"])}. Join link meet.example/${hex(10)}.`],
    ["digest", "digest@news.example", () => `Your weekly digest #${Math.floor(100 + rnd() * 899)}`, () => `This week: ${pick(["edge computing", "vector databases", "email security"])}, ${pick(["remote work", "open source funding", "rust in production"])}, and ${Math.floor(3 + rnd() * 9)} more stories.`],
    ["deploy-ok", "ci@builds.example", () => `Deploy succeeded: ${pick(["web", "api", "worker"])}`, () => `Deployment of ${pick(["web", "api", "worker"])} succeeded at commit ${hex(7)} in ${Math.floor(30 + rnd() * 300)} seconds.`],
    ["reset", "security@accounts.example", () => "Reset your password", () => `Someone asked to reset the password for your account. Use code ${String(Math.floor(100000 + rnd() * 899999))} within 15 minutes. If it was not you, ignore this.`],
  ];
  for (const [fam, from, subj, body] of FAMS) {
    for (let i = 0; i < 25; i++) {
      add({ id: `${fam}-${i}@x2.example`, from, subject: subj(), body: body(), date: nextDate(), family: fam });
    }
  }
  const thread2Ids = THREADS2.map(([subject, bodies], t) => {
    const ids = [];
    bodies.forEach((body, k) => {
      ids.push(add({
        id: `t2-${t}-${k}@team.example`, from: k % 2 ? ME : `peer${t % 6}@team.example`, to: k % 2 ? `peer${t % 6}@team.example` : ME,
        subject: k ? `Re: ${subject}` : subject, body, date: nextDate(), inReplyTo: k ? `t2-${t}-${k - 1}@team.example` : null, family: "thread",
      }));
    });
    return ids;
  });
  THREADS2.forEach(([, , para], t) => queries.push({ family: "paraphrase", q: para, gold: thread2Ids[t] }));
  const newest = (fam) => messages.filter((m) => m.family === fam).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  for (const fam of ["deploy-ok", "reset"]) queries.push({ family: "latest", q: newest(fam).subject, gold: [newest(fam).id] });
  const D = (q, goldFamilies) => queries.push({ family: "diversity", q, goldFamilies });
  D("bills and payment reminders", ["invoice", "order"]);
  D("meetings on my calendar and newsletters", ["calendar", "digest"]);
  D("deployments and build results", ["deploy-ok", "ci:corpus-sync", "ci:nightly-index", "ci:deploy-staging", "pr"]);
  D("account security emails", ["login", "reset"]);
  D("emails sent by machines, not people", ["invoice", "calendar", "digest", "deploy-ok", "reset", "order", "login"]);
  D("what did the build system tell me", ["deploy-ok", "ci:corpus-sync", "ci:nightly-index", "ci:deploy-staging"]);
  D("shopping, billing and subscriptions", ["order", "invoice", "digest"]);
  D("anything about passwords or sign in", ["reset", "login"]);
  D("scheduling and reminders", ["calendar", "login"]);
  D("money owed and things shipped", ["invoice", "order"]);
  D("reading material and news", ["digest"]);
  D("pull requests and deploys", ["pr", "deploy-ok"]);
}

// #950: GitHub Actions "PR run failed" notifications. Each subject is unique (a workflow and a PR
// title occur together once), so the family key (semrank templateKey) calls every one of them a
// unique shape, as production's did. But every body is the same long Actions template: the job
// table, the run links and the footer. Only a repo-local run id, a sha, the PR number and a few job
// timings differ. That is the class #940's classification found: the template dominates chunk 0.
// ALL SYNTHETIC: invented repo, people, titles and ids.
const WORKFLOWS950 = ["ci", "CodeQL", "release-gate", "coverage", "deploy-preview", "lint", "e2e", "docs"];
const TITLES950 = [
  "Add retry to the webhook sender", "Fix timezone drift in the scheduler", "Move image uploads to R2",
  "Cache the pricing table at the edge", "Drop the legacy session cookie", "Paginate the audit log API",
];
const JOBS950 = ["build (ubuntu-latest, node 22)", "test (unit)", "test (integration)", "typecheck", "lint", "bundle-size", "e2e (chromium)", "e2e (webkit)"];
function actionsBody(rnd, workflow, title, pr, sha, runId) {
  const failed = JOBS950[Math.floor(rnd() * JOBS950.length)];
  const secs = () => `${Math.floor(rnd() * 4)}m ${Math.floor(10 + rnd() * 49)}s`;
  const rows = JOBS950.map((j) => (j === failed ? `  X ${j}    Failed in ${secs()}    1 error, 2 warnings` : `  OK ${j}    Succeeded in ${secs()}`));
  return [
    `acme/widget | ${workflow} workflow run`,
    "",
    `${title}`,
    `Pull request #${pr} by octo-dev, head ${sha}`,
    "",
    `${workflow}: Some jobs were not successful`,
    "",
    "Jobs",
    ...rows,
    "",
    "Annotations",
    "  1 error and 2 warnings",
    `  X ${failed}: Process completed with exit code 1.`,
    "  ! Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@v4, actions/setup-node@v4. Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026.",
    "  ! The `set-output` command is deprecated and will be disabled soon. Please upgrade to using Environment Files.",
    "",
    `View workflow run: https://github.example/acme/widget/actions/runs/${runId}`,
    `View pull request: https://github.example/acme/widget/pull/${pr}`,
    "",
    "--",
    "You are receiving this email because you are subscribed to GitHub Actions notifications for workflow runs you triggered or for repositories you watch.",
    "Manage your GitHub Actions notifications: https://github.example/settings/notifications",
    "To stop receiving these emails, change your notification settings. GitHub, Inc. 88 Colin P Kelly Jr Street, San Francisco, CA 94107 (synthetic).",
  ].join("\n");
}
function extendCorpus950(messages, queries) {
  const rnd = mulberry32(950);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
  const base = Date.UTC(2026, 10, 1);
  let tick = 0;
  const nextDate = () => new Date(base + (tick++) * 3_600_000 * 3).toISOString();
  const ids = [];
  WORKFLOWS950.forEach((workflow, w) => {
    TITLES950.forEach((title, t) => {
      const pr = 400 + t;
      const sha = hex(7);
      const id = `gha-${w}-${t}@github.example`;
      messages.push({
        to: ME, inReplyTo: null, id, from: "notifications@github.example",
        subject: `[acme/widget] PR run failed: ${workflow} - ${title} (${sha})`,
        body: actionsBody(rnd, workflow, title, pr, sha, 7_000_000 + w * 100 + t), date: nextDate(), family: `gha:${workflow}:${t}`,
      });
      ids.push({ id, workflow, title });
    });
  });
  // The production probe shape: the message searched by its own exact subject (12 probes, spread).
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (let k = 0; k < 12; k++) {
    const x = ids[Math.floor((k * ids.length) / 12)];
    queries.push({ family: "actions", q: byId.get(x.id).subject, gold: [x.id] });
  }
  // A person's shape: the workflow and the PR title, no repo, no sha (12 probes, offset by 2).
  for (let k = 0; k < 12; k++) {
    const x = ids[(Math.floor((k * ids.length) / 12) + 2) % ids.length];
    queries.push({ family: "actions-title", q: `${x.workflow} failed on ${x.title}`, gold: [x.id] });
  }
}

export function buildCorpus() {
  const rnd = mulberry32(813);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const base = Date.UTC(2026, 5, 1);
  let tick = 0;
  const nextDate = () => new Date(base + (tick++) * 3_600_000 * 7).toISOString();
  const messages = [];
  const queries = [];
  const add = (m) => (messages.push({ to: ME, inReplyTo: null, ...m }), m.id);

  // Templated: CI run failures, 40 per job.
  const ciByJob = Object.fromEntries(JOBS.map((j) => [j, []]));
  for (let i = 0; i < 120; i++) {
    const job = JOBS[i % JOBS.length];
    const commit = hex(7);
    const id = add({
      id: `ci-${i}@builds.example`, from: "ci@builds.example", subject: `Run failed: ${job}`, date: nextDate(),
      body: `The ${job} job failed at commit ${commit}. Step ${pick(STEPS)} exited with status ${1 + Math.floor(rnd() * 3)}. Logs: https://ci.example/runs/${10000 + i}`,
      token: commit, family: `ci:${job}`,
    });
    ciByJob[job].push(id);
  }
  // Templated: PR check failures, 40.
  const prIds = [];
  for (let i = 0; i < 40; i++) {
    const pr = 900 + i;
    prIds.push(add({
      id: `pr-${i}@github.example`, from: "notifications@github.example", subject: `PR #${pr} run failed: ci`, date: nextDate(),
      body: `The ci workflow failed on pull request #${pr} (branch feature/${hex(4)}, head ${hex(7)}). 2 jobs failed, 14 passed.`,
      token: `#${pr}`, family: "pr",
    }));
  }
  // Templated: orders shipped, 40.
  const orderIds = [];
  for (let i = 0; i < 40; i++) {
    const order = `SH-${String(Math.floor(10000 + rnd() * 89999))}`;
    orderIds.push(add({
      id: `order-${i}@shop.example`, from: "receipts@orders.shop.example", subject: `Order ${order} has shipped`, date: nextDate(),
      body: `Good news: your order ${order} (${pick(ITEMS)}) is on its way with ${pick(CARRIERS)}. Tracking number ${hex(12).toUpperCase()}.`,
      token: order, family: "order",
    }));
  }
  // Templated: sign-in alerts, 30.
  for (let i = 0; i < 30; i++) {
    add({
      id: `login-${i}@accounts.example`, from: "security@accounts.example", subject: "New sign-in to your account", date: nextDate(),
      body: `We noticed a new sign-in from ${pick(DEVICES)} near ${pick(CITIES)}. If this was you, no action is needed. Reference ${hex(8)}.`,
      family: "login",
    });
  }
  // Short human mail.
  const shortIds = SHORT.map(([subject, body], i) => add({ id: `short-${i}@team.example`, from: `friend${i % 7}@people.example`, subject, body, date: nextDate(), family: "short" }));
  // Threads.
  const threadIds = THREADS.map(([subject, bodies], t) => {
    const ids = [];
    bodies.forEach((body, k) => {
      ids.push(add({
        id: `thread-${t}-${k}@team.example`, from: k % 2 ? ME : `colleague${t % 5}@team.example`, to: k % 2 ? `colleague${t % 5}@team.example` : ME,
        subject: k ? `Re: ${subject}` : subject, body, date: nextDate(), inReplyTo: k ? `thread-${t}-${k - 1}@team.example` : null, family: "thread",
      }));
    });
    return ids;
  });

  // --- Queries ---
  const byId = new Map(messages.map((m) => [m.id, m]));
  // token: 10 CI, 8 PR, 8 orders, chosen deterministically across the families.
  const tokenPick = (ids, n) => Array.from({ length: n }, (_, k) => ids[Math.floor((k * ids.length) / n)]);
  for (const id of [...tokenPick([...ciByJob["corpus-sync"], ...ciByJob["nightly-index"], ...ciByJob["deploy-staging"]], 10), ...tokenPick(prIds, 8), ...tokenPick(orderIds, 8)]) {
    const m = byId.get(id);
    const q = m.family.startsWith("ci:") ? `${m.family.slice(3)} failed ${m.token}` : m.family === "pr" ? `pull request ${m.token} ci failed` : `order ${m.token} shipped`;
    queries.push({ family: "token", q, gold: [id] });
  }
  // latest: the shared subject of each CI job and the sign-in alerts; gold = newest member.
  const newest = (fam) => messages.filter((m) => m.family === fam).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  for (const fam of [...JOBS.map((j) => `ci:${j}`), "login"]) {
    const m = newest(fam);
    queries.push({ family: "latest", q: m.subject, gold: [m.id] });
  }
  // subject: every short mail by its exact subject.
  SHORT.forEach(([subject], i) => queries.push({ family: "subject", q: subject, gold: [shortIds[i]] }));
  // paraphrase: every short mail and every thread.
  SHORT.forEach(([, , para], i) => queries.push({ family: "paraphrase", q: para, gold: [shortIds[i]] }));
  THREADS.forEach(([, , para], t) => queries.push({ family: "paraphrase", q: para, gold: threadIds[t] }));
  // diversity: gold = the set of families that answer it; coverage = families present in the top 10.
  queries.push({ family: "diversity", q: "build and test failures", goldFamilies: ["ci:corpus-sync", "ci:nightly-index", "ci:deploy-staging", "pr"] });
  queries.push({ family: "diversity", q: "automated notifications I received", goldFamilies: ["ci:corpus-sync", "ci:nightly-index", "ci:deploy-staging", "pr", "order", "login"] });
  queries.push({ family: "diversity", q: "deliveries and account security", goldFamilies: ["order", "login"] });
  extendCorpus(messages, queries);
  extendCorpus950(messages, queries);
  return { messages, queries };
}
