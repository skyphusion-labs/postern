-- Synthetic, obviously-fake demo data for README screenshots. example.com only.
INSERT INTO messages (message_id, from_addr, to_addr, subject, date, in_reply_to, body_text, spf, dkim, dmarc, trusted, received_at, direction, thread_id) VALUES
 ('0c5f2a@agents.example', 'ci-agent@acme.example', 'dev-team@acme.example', 'Re: Nightly build #4821 results', '2026-06-19T07:42:00Z', '771be3@acme.example', 'All green. 1,204 tests passed in 6m12s. Coverage 91.3% (+0.4). Artifacts pushed to the registry. I will redeploy staging at 08:00 unless someone objects.

-- ci-agent', 'pass','pass','pass',1,'2026-06-19T07:42:01Z','outbound','771be3@acme.example'),
 ('771be3@acme.example', 'dev-team@acme.example', 'ci-agent@acme.example', 'Nightly build #4821 results', '2026-06-19T07:30:00Z', NULL, 'Can you confirm the nightly build is green and post the coverage delta? Hold the staging deploy until we hear back from QA.', 'pass','pass','pass',1,'2026-06-19T07:30:02Z','inbound','771be3@acme.example'),
 ('b42d10@research.example', 'digest@research.example', 'agent@myteam.example', 'Your weekly research digest (12 new papers)', '2026-06-19T06:05:00Z', NULL, '12 new papers matched your topics this week.

1. Retrieval-augmented agents over private mail stores
2. Constant-time auth in edge runtimes
3. A survey of IMAP proxies for structured backends

Full list and abstracts attached.', 'pass','pass','pass',1,'2026-06-19T06:05:03Z','inbound','b42d10@research.example'),
 ('fa9c07@orders.shop.example', 'receipts@orders.shop.example', 'agent@myteam.example', 'Order SH-99210 has shipped', '2026-06-18T19:20:00Z', NULL, 'Your order SH-99210 is on its way. Tracking: 1Z-DEMO-TRACK. Estimated delivery: Jun 22.

Thanks for shopping with us.', 'pass','pass','none',1,'2026-06-18T19:20:04Z','inbound','fa9c07@orders.shop.example'),
 ('deef88@unknown.example', 'promo@unknown-sender.example', 'agent@myteam.example', 'You have been selected!! claim your reward', '2026-06-18T14:11:00Z', NULL, 'Click here to claim. (This message failed SPF/DKIM and is shown so you can see how Postern surfaces an untrusted sender in the UI.)', 'fail','none','fail',0,'2026-06-18T14:11:05Z','inbound','deef88@unknown.example'),
 ('1188af@myteam.example', 'agent@myteam.example', 'ops@myteam.example', 'Deploy summary: postern v1.0', '2026-06-18T11:00:00Z', NULL, 'Deployed postern v1.0. Inbound + outbound verified, store healthy, webmail live at /webmail. Sending this copy so the thread is complete in the mailbox.', 'pass','pass','pass',1,'2026-06-18T11:00:01Z','outbound','1188af@myteam.example');
INSERT INTO attachments (message_id, filename, mime, size, r2_key, created_at) VALUES
 ('b42d10@research.example', 'digest-2026-W25.pdf', 'application/pdf', 184320, 'demo/digest.pdf', '2026-06-19T06:05:03Z');

-- An HTML newsletter (#820) so the README HTML-email shot is reproducible from this seed.
-- The remote image is deliberate: webmail strips it and shows the blocked-content notice.
INSERT INTO messages (message_id, from_addr, to_addr, subject, date, in_reply_to, body_text, body_html, spf, dkim, dmarc, trusted, received_at, direction, thread_id) VALUES
 ('5e77c1@news.example', 'newsletter@news.example', 'agent@myteam.example', 'This week at Example Labs: faster builds', '2026-06-19T09:30:00Z', NULL,
  'This week at Example Labs. Faster builds: incremental caching cut median CI time by 38 percent. Read more at https://news.example/w25',
  '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1f2937"><div style="background:#0f766e;color:#ffffff;padding:20px 24px;border-radius:8px 8px 0 0"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Example Labs weekly</div><h1 style="margin:6px 0 0;font-size:26px">Faster builds, calmer on-call</h1></div><img src="https://tracker.news.example/open.gif?u=42" width="1" height="1" alt=""><div style="padding:20px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px"><p style="font-size:16px;line-height:1.6">Incremental caching landed in the build farm this week. Median CI time dropped by <b>38 percent</b>, and the p95 is down from 14 to 8 minutes.</p><img src="https://cdn.news.example/chart-w25.png" alt="Build time chart" width="480" style="display:block;margin:12px 0"><p style="font-size:16px;line-height:1.6">On-call pages fell to three for the week, all of them actionable.</p><p><a href="https://news.example/w25" style="display:inline-block;background:#0f766e;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">Read the full issue</a></p><p style="font-size:12px;color:#6b7280">You get this because you subscribed at news.example.</p></div></div>',
  'pass','pass','pass',1,'2026-06-19T09:30:04Z','inbound','5e77c1@news.example');
