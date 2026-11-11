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
  return { messages, queries };
}
