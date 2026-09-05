/**
 * The dashboard chrome. One place owns navigation, palette and spacing so every page
 * inherits the same frame instead of each rebuilding it slightly differently.
 *
 * Server rendered on purpose. This console shows live API keys and mandate state; a
 * single page app would mean shipping that to a bundle and trusting the client to decide
 * what to display. Here the server decides, and a page a merchant may not see is a page
 * that is never rendered.
 */

export function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface NavSection {
  readonly title: string;
  readonly items: ReadonlyArray<{ key: string; href: string; label: string }>;
}

const NAV: readonly NavSection[] = [
  {
    title: "Monitor",
    items: [
      { key: "home", href: "/dashboard", label: "Overview" },
      { key: "activity", href: "/dashboard/activity", label: "Agent activity" },
      { key: "mandates", href: "/dashboard/mandates", label: "Permissions" },
    ],
  },
  {
    title: "Configure",
    items: [
      { key: "keys", href: "/dashboard/keys", label: "API keys" },
      { key: "integration", href: "/dashboard/integration", label: "Integration" },
    ],
  },
  {
    title: "Build",
    items: [{ key: "docs", href: "/dashboard/docs", label: "Documentation" }],
  },
];

const STYLE = `
:root{
  --bg:#FCFCFB; --panel:#FFFFFF; --sink:#F5F5F3; --sink-2:#EDEDEA;
  --ink:#15161A; --ink-2:#3C3F45; --ink-3:#767981;
  --line:#E3E3DF; --line-2:#EEEEEB;
  --accent:#1D4E5F; --accent-ink:#FFFFFF; --accent-wash:#E8F0F1; --accent-line:#BFD5D9;
  --ok:#4A6F5C; --warn:#7A6636; --stop:#8E463C;
  --radius:6px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#121316; --panel:#191A1E; --sink:#1F2126; --sink-2:#26282E;
    --ink:#F4F5F6; --ink-2:#D2D5DA; --ink-3:#949AA4;
    --line:#2A2D33; --line-2:#232529;
    --accent:#7FC7D4; --accent-ink:#121316; --accent-wash:#17282C; --accent-line:#2B4B53;
    --ok:#8FBBA6; --warn:#C0AA82; --stop:#D89A8E;
  }
}
:root[data-theme="dark"]{
  --bg:#121316; --panel:#191A1E; --sink:#1F2126; --sink-2:#26282E;
  --ink:#F4F5F6; --ink-2:#D2D5DA; --ink-3:#949AA4;
  --line:#2A2D33; --line-2:#232529;
  --accent:#7FC7D4; --accent-ink:#121316; --accent-wash:#17282C; --accent-line:#2B4B53;
  --ok:#8FBBA6; --warn:#C0AA82; --stop:#D89A8E;
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:"Open Sans",ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px;line-height:1.62;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
a:focus-visible,button:focus-visible,input:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
code,.mono,pre{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-size:.86em;background:var(--sink);padding:1px 5px;border-radius:3px;color:var(--ink-2)}

/* frame */
.frame{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
/* The reading column is what matters. Everything around it gives way first: the app rail
   narrows, then the contents rail goes, then the docs nav, and only then does anything
   stack. The chrome is otherwise about 900px before a word of content appears. */
@media (max-width:1660px){.frame{grid-template-columns:216px minmax(0,1fr)}}
@media (max-width:1400px){.frame{grid-template-columns:196px minmax(0,1fr)}}
@media (max-width:1180px){.frame{grid-template-columns:188px minmax(0,1fr)}}
@media (max-width:900px){.frame{grid-template-columns:1fr}.rail{display:none}}
.rail{
  background:var(--panel);border-right:1px solid var(--line);
  padding:20px 12px;display:flex;flex-direction:column;gap:22px;
  position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:9px;padding:2px 8px 0}
.brand .mark{
  width:24px;height:24px;border-radius:5px;background:var(--accent);color:var(--accent-ink);
  display:grid;place-items:center;font-weight:800;font-size:12px}
.brand .name{font-weight:700;letter-spacing:-.015em;font-size:15px}
.navgroup{display:flex;flex-direction:column;gap:1px}
.navgroup .gt{
  font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-3);padding:0 10px;margin-bottom:5px}
.navgroup a{
  padding:6px 10px;border-radius:5px;color:var(--ink-2);font-size:13.5px;font-weight:600}
.navgroup a:hover{background:var(--sink);text-decoration:none;color:var(--ink)}
.navgroup a[aria-current]{background:var(--accent-wash);color:var(--accent);font-weight:600}
.rail .foot{margin-top:auto;padding:12px 10px 0;border-top:1px solid var(--line-2);font-size:12.5px}
.rail .foot .biz{font-weight:700;color:var(--ink-2)}
.rail .foot .em{color:var(--ink-3);margin-top:1px}
.rail .foot button{
  background:none;border:0;padding:0;margin-top:8px;color:var(--ink-3);
  font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.rail .foot button:hover{color:var(--stop)}

.main{padding:28px 34px 80px;max-width:1180px;min-width:0}
.main.wide{max-width:none;padding-right:44px}
@media (max-width:1660px){.main{padding:26px 24px 70px}.main.wide{padding-right:24px}}
@media (max-width:1180px){.main{padding:22px 20px 64px}.main.wide{padding-right:20px}}
@media (max-width:900px){.main{padding:20px 16px 60px}.main.wide{padding-right:16px}}
@media (max-width:900px){.main{padding:20px 16px 60px}}

/* page head */
.head{margin-bottom:24px}
.head h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0 0 5px}
.head p{margin:0;color:var(--ink-2);font-size:14.5px;max-width:78ch;
  font-weight:500;line-height:1.6}

/* panel */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:18px}
.panel > header{
  padding:13px 16px;border-bottom:1px solid var(--line-2);
  display:flex;align-items:center;justify-content:space-between;gap:14px}
.panel > header h2{font-size:15px;font-weight:700;margin:0;letter-spacing:-.005em;color:var(--ink)}
.panel > header p{margin:3px 0 0;font-size:13px;color:var(--ink-3);font-weight:500}
.panel .body{padding:16px}
.panel .body.flush{padding:0}

/* stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 15px}
.stat .k{font-size:12.5px;color:var(--ink-3);margin-bottom:6px;font-weight:600;letter-spacing:.01em}
.stat .v{font-size:28px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.05}
.stat .sub{font-size:12.5px;color:var(--ink-3);margin-top:4px;font-weight:500}

/* table */
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:560px}
thead th{
  text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-3);padding:9px 16px;border-bottom:1px solid var(--line);white-space:nowrap;
  background:var(--sink)}
tbody td{padding:11px 16px;border-bottom:1px solid var(--line-2);vertical-align:middle;
  font-weight:500;font-size:13.5px}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--sink)}
td.num,th.num{font-variant-numeric:tabular-nums;text-align:right}
td.id{font-family:"JetBrains Mono",monospace;font-size:11.5px;color:var(--ink-3)}
.empty{padding:36px 16px;text-align:center;color:var(--ink-3);font-size:14px;font-weight:500}

/* verdicts read as a dot plus a word, not a wall of coloured badges */
.v{font-weight:600;font-size:13px;white-space:nowrap;color:var(--ink-2)}
.v.deny{color:var(--stop)}
.v.stepup{color:var(--ink-2)}
.v.allow{color:var(--ink-2)}
.rc{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--ink-3);margin-left:8px}
.state{font-size:13px;font-weight:600}
.state.on{color:var(--ok)}
.state.off{color:var(--ink-3)}

/* forms */
label{display:block;font-size:13.5px;font-weight:700;margin-bottom:5px;color:var(--ink)}
.hint{font-size:13px;color:var(--ink-3);margin:6px 0 0;line-height:1.6;font-weight:500}
input[type=text],input[type=email],input[type=password],input[type=url]{
  width:100%;padding:9px 12px;font:inherit;font-size:14.5px;font-weight:500;color:var(--ink);
  background:var(--bg);border:1px solid var(--line);border-radius:5px}
input:focus{border-color:var(--accent)}
.field{margin-bottom:15px}
button.btn,a.btn{
  display:inline-block;padding:8px 15px;font:inherit;font-size:13.5px;font-weight:700;
  border-radius:5px;border:1px solid transparent;cursor:pointer;
  background:var(--accent);color:var(--accent-ink);letter-spacing:.005em}
button.btn:hover,a.btn:hover{filter:brightness(1.08);text-decoration:none}
button.btn.ghost,a.btn.ghost{background:transparent;color:var(--ink-2);border-color:var(--line)}
button.btn.ghost:hover{background:var(--sink);filter:none}
button.btn.danger{background:transparent;color:var(--stop);border-color:var(--stop)}

/* notices */
.notice{border-left:2px solid var(--line);padding:2px 0 2px 16px;font-size:14px;
  margin:0 0 20px;color:var(--ink-2);line-height:1.65;font-weight:500}
.notice strong{color:var(--ink)}

/* secret */
.secret{
  background:var(--sink);border:1px solid var(--line);border-radius:5px;padding:10px 12px;
  font-family:"JetBrains Mono",monospace;font-size:12px;word-break:break-all;
  display:flex;align-items:center;justify-content:space-between;gap:12px}
.secret button{
  background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:5px 10px;
  font:inherit;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink-2);white-space:nowrap}

/* code */
pre.code{
  background:var(--sink);border:1px solid var(--line);border-radius:5px;padding:13px 15px;
  overflow-x:auto;font-size:12.5px;line-height:1.65;margin:0 0 14px;color:var(--ink-2)}
pre.code .c{color:var(--ink-3);font-style:italic}
pre.code .s{color:var(--accent)}
pre.code .k{color:var(--ink);font-weight:600}

/* auth */
.authwrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.authcard{width:100%;max-width:380px}
.authcard .brand{justify-content:center;margin-bottom:20px}
.authcard .alt{text-align:center;font-size:13.5px;color:var(--ink-3);font-weight:500}

@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">`;

export interface ShellOptions {
  readonly title: string;
  readonly active: string;
  readonly merchantName: string;
  readonly email: string;
}

export function shell(options: ShellOptions, body: string): string {
  const nav = NAV.map(
    (section) => `<div class="navgroup"><div class="gt">${escape(section.title)}</div>` +
      section.items.map((item) =>
        `<a href="${item.href}"${item.key === options.active ? ' aria-current="page"' : ""}>${escape(item.label)}</a>`,
      ).join("") + `</div>`,
  ).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(options.title)} · AgentKit</title>${FONTS}<style>${STYLE}</style></head>
<body><div class="frame">
  <aside class="rail">
    <div class="brand"><span class="mark">A</span><span class="name">AgentKit</span></div>
    ${nav}
    <div class="foot">
      <div class="biz">${escape(options.merchantName)}</div>
      <div class="em">${escape(options.email)}</div>
      <form method="POST" action="/dashboard/signout"><button type="submit">Sign out</button></form>
    </div>
  </aside>
  <main class="main">${body}</main>
</div></body></html>`;
}

/** The docs use the same chrome plus a contents rail, so they feel like one product. */
export function docsShell(
  options: ShellOptions,
  sidebar: string,
  contents: string,
  body: string,
): string {
  const nav = NAV.map(
    (section) => `<div class="navgroup"><div class="gt">${escape(section.title)}</div>` +
      section.items.map((item) =>
        `<a href="${item.href}"${item.key === options.active ? ' aria-current="page"' : ""}>${escape(item.label)}</a>`,
      ).join("") + `</div>`,
  ).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(options.title)} · AgentKit</title>${FONTS}<style>${STYLE}
.docframe{display:grid;grid-template-columns:216px minmax(0,1fr) 212px;gap:40px;align-items:start}
@media (max-width:1660px){.docframe{grid-template-columns:200px minmax(0,1fr) 188px;gap:32px}}
/* Below this the contents rail costs more than it gives, so the reading column takes it. */
@media (max-width:1560px){.docframe{grid-template-columns:192px minmax(0,1fr);gap:30px}
  .toc{display:none}}
@media (max-width:900px){.docframe{grid-template-columns:1fr;gap:0}.docnav{display:none}}
.docnav{position:sticky;top:28px;max-height:calc(100vh - 56px);overflow-y:auto}
.docnav .gt{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-3);margin:20px 0 6px;padding:0 9px}
.docnav .gt:first-child{margin-top:0}
.docnav a{display:block;padding:6px 10px;border-radius:4px;font-size:14px;color:var(--ink-2);
  font-weight:600;line-height:1.45}
.docnav a:hover{background:var(--sink);text-decoration:none;color:var(--ink)}
.docnav a[aria-current]{background:var(--accent-wash);color:var(--accent);font-weight:600}

.toc{position:sticky;top:28px;font-size:13.5px;max-height:calc(100vh - 56px);overflow-y:auto}
.toc .gt{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-3);margin-bottom:9px}
.toc a{display:block;padding:3px 0;color:var(--ink-3);line-height:1.45;font-weight:600}
.toc a:hover{color:var(--accent);text-decoration:none}
.toc a.sub{padding-left:12px;font-size:12px}

.doc{min-width:0;padding-bottom:60px}
.doc h1{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:0 0 12px;line-height:1.2}
@media (max-width:1560px){.doc h1{font-size:30px}}
@media (max-width:900px){.doc h1{font-size:26px}}
.doc .sub{color:var(--ink-2);font-size:16.5px;margin:0 0 8px;max-width:84ch;
  line-height:1.55;font-weight:500}
.doc .readtime{font-size:12.5px;color:var(--ink-3);margin:0 0 24px;
  padding-bottom:18px;border-bottom:1px solid var(--line)}
.doc h2{font-size:23px;font-weight:700;letter-spacing:-.012em;margin:36px 0 12px;
  color:var(--ink);scroll-margin-top:24px}
@media (max-width:1560px){.doc h2{font-size:21px;margin-top:32px}}
.doc h3{font-size:17.5px;font-weight:700;margin:26px 0 9px;color:var(--ink);scroll-margin-top:24px}
.doc h4{font-size:15px;font-weight:700;margin:20px 0 7px;color:var(--ink)}
.doc p{margin:0 0 15px;max-width:88ch;color:var(--ink-2);font-size:15.5px;
  line-height:1.7;font-weight:500}
.doc p.lead{color:var(--ink);font-size:17px;line-height:1.7}
.doc ul,.doc ol{margin:0 0 16px;padding-left:22px;max-width:88ch;color:var(--ink-2);
  font-size:15.5px;line-height:1.7;font-weight:500}
.doc li{margin-bottom:7px}
.doc li > code{white-space:nowrap}
.doc strong{color:var(--ink);font-weight:700}
.doc hr{border:0;border-top:1px solid var(--line);margin:38px 0}
.doc .callout{border-left:2px solid var(--line);padding:2px 0 2px 18px;
  margin:22px 0;max-width:86ch}
.doc .callout p{margin:0;font-size:15px;line-height:1.7;font-weight:500}
.doc .callout p + p{margin-top:9px}
.doc .callout .ct{font-size:15.5px;font-weight:700;color:var(--ink);display:block;
  margin-bottom:6px}


/* code block with a language label and a copy button, like a real docs site */
.cb{margin:0 0 18px;border:1px solid var(--line);border-radius:6px;overflow:hidden;
  background:var(--sink)}
.cb pre{margin:0;padding:16px 18px;overflow-x:auto;font-size:13.4px;line-height:1.72;
  color:var(--ink-2);background:none;border:0}
.cb figcaption{display:flex;align-items:center;justify-content:space-between;
  padding:7px 12px 7px 17px;border-top:1px solid var(--line);background:var(--panel)}
.cb .lang{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-3)}
.cb button{display:inline-flex;align-items:center;gap:6px;background:var(--sink);
  border:1px solid var(--line);border-radius:4px;padding:4px 10px;font:inherit;font-size:11.5px;
  font-weight:600;color:var(--ink-2);cursor:pointer;font-family:"Open Sans",sans-serif}
.cb button:hover{color:var(--ink);border-color:var(--ink-3)}
.cb pre .c{color:var(--ink-3);font-style:italic}
.cb pre .s{color:var(--accent)}
.cb pre .k{color:var(--ink);font-weight:600}

.doc table{margin:0 0 20px;min-width:0}
.doc thead th{padding:10px 16px;font-size:11px}
.doc tbody td{padding:12px 16px;font-size:14.5px;color:var(--ink-2);line-height:1.6;
  font-weight:500}
.doc tbody td:first-child{white-space:nowrap}
.doc .tablewrap{border:1px solid var(--line);border-radius:6px;overflow:auto;margin-bottom:20px}
.doc .tablewrap table{border-radius:0}

/* The generated endpoint reference. Class is a permission level, so it is coloured by
   what the tool can reach rather than for decoration. */
.doc .endpoint{border-top:1px solid var(--line);padding-top:20px;margin-bottom:26px}
.doc .endpoint h3{display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:15.5px}
.doc .endpoint h3 code{font-size:14.5px;font-weight:700}
.doc .endpoint .verb{margin:0 0 10px}
.doc .endpoint .verb code{font-size:13px;color:var(--ink-2);font-weight:600}
.doc .endpoint > p{margin:0 0 12px}
.doc .endpoint .denials{font-size:13.5px;color:var(--ink-2);margin:-8px 0 0}

.doc .pill{font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  padding:3px 8px;border-radius:4px;border:1px solid var(--line);color:var(--ink-2);
  white-space:nowrap}
.doc .pill-read{border-color:#9fb8c4;color:#3f6478}
.doc .pill-propose{border-color:#b0aec6;color:#585179}
.doc .pill-money{border-color:#c9a26b;color:#8a5f1d}
.doc .pill-margin{border-color:#a9bb9a;color:#4f6b3f}

/* Chain verification. Monospace throughout: these are bytes, and they are meant to be
   compared by eye against the row they came from. */
.cxsum{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;
  border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-bottom:22px}
.cxsum-bad{border-color:#b4544e}
.cxsum .cxk{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;
  color:var(--ink-2);margin-bottom:5px;font-weight:700}
.cxsum code{font-size:12.5px;word-break:break-all}

.cxexplain{border-left:2px solid var(--line);padding:2px 0 2px 18px;margin:0 0 26px}
.cxexplain h2{font-size:15.5px;margin:0 0 8px}
.cxexplain p{margin:0 0 9px;font-size:14.5px;line-height:1.7;font-weight:500}
.cxexplain code{font-size:13px}

.cxh2{font-size:15.5px;margin:26px 0 12px}

.cx{border:1px solid var(--line);border-radius:8px;margin-bottom:14px;overflow:hidden}
.cx-bad{border-color:#b4544e}
.cxh{display:flex;align-items:center;gap:12px;padding:11px 16px;
  border-bottom:1px solid var(--line);background:rgba(127,127,127,.05)}
.cxseq{font-family:ui-monospace,monospace;font-size:12.5px;font-weight:700;color:var(--ink-2)}
.cxkind{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.cxwhen{font-size:12px;color:var(--ink-2);margin-left:auto}
.cxverdict{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  color:#3f7a52}
.cx-bad .cxverdict{color:#b4544e}

.cxrow{display:grid;grid-template-columns:130px 1fr;gap:16px;padding:14px 16px;
  border-top:1px solid var(--line)}
.cxrow:first-of-type{border-top:0}
.cxlabel{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);
  font-weight:700;padding-top:2px}
.cxval code{font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all;
  line-height:1.7}
.cxformula{margin:0 0 6px}
.cxbytes{font-family:ui-monospace,monospace;font-size:12px;line-height:1.65;margin:0;
  padding:11px 13px;border:1px solid var(--line);border-radius:6px;overflow-x:auto;
  white-space:pre-wrap;word-break:break-all}
.cxnote{margin:8px 0 0;font-size:13.5px;line-height:1.65;color:var(--ink-2)}
.cxwarn{color:#b4544e;font-weight:600}
.cxfoot{margin-top:22px;font-size:13.5px;color:var(--ink-2)}

@media (max-width:720px){ .cxrow{grid-template-columns:1fr;gap:6px} }

.steps{counter-reset:s;list-style:none;padding:0;margin:0 0 20px;max-width:none}
.steps > li{counter-increment:s;position:relative;padding-left:38px;margin-bottom:26px}
.steps > li::before{content:counter(s);position:absolute;left:0;top:0;width:25px;height:25px;
  border-radius:6px;background:var(--accent);color:var(--accent-ink);
  font-size:12px;font-weight:800;display:grid;place-items:center}
.steps > li > h3{margin:2px 0 8px;font-size:15px}
.steps > li > p:last-child,.steps > li > .cb:last-child{margin-bottom:0}
</style></head>
<body><div class="frame">
  <aside class="rail">
    <div class="brand"><span class="mark">A</span><span class="name">AgentKit</span></div>
    ${nav}
    <div class="foot">
      <div class="biz">${escape(options.merchantName)}</div>
      <div class="em">${escape(options.email)}</div>
      <form method="POST" action="/dashboard/signout"><button type="submit">Sign out</button></form>
    </div>
  </aside>
  <main class="main wide"><div class="docframe">
    <nav class="docnav">${sidebar}</nav>
    <article class="doc">${body}</article>
    <nav class="toc">${contents}</nav>
  </div></main>
</div>
<script>
  document.querySelectorAll(".cb button").forEach(function (button) {
    button.addEventListener("click", function () {
      var code = button.closest(".cb").querySelector("pre");
      navigator.clipboard.writeText(code.innerText).then(function () {
        var was = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () { button.textContent = was; }, 1500);
      });
    });
  });
</script>
</body></html>`;
}

export function authShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · AgentKit</title>${FONTS}<style>${STYLE}</style></head>
<body><div class="authwrap"><div class="authcard">
  <div class="brand"><span class="mark">A</span><span class="name">AgentKit</span></div>
  ${body}
</div></div></body></html>`;
}
