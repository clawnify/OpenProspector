// Editorial UI illustrations of existing capabilities. These are recreated
// HTML/SVG panels, not application screenshots or proposed product screens.
const glyphs = {
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down: '<path d="M12 5v14m6-6-6 6-6-6"/>',
  arrowUp: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  repeat: '<path d="M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8M18 2v4h-4M6 22v-4h4"/>',
  external: '<path d="M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const icon = name => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`;
const badge = (text, tone = 'green', glyph = '') => `<span class="badge ${tone}">${glyph ? icon(glyph) : ''}${text}</span>`;
const chip = text => `<span class="chip">${text}</span>`;
// Vendor marks are the favicons the app itself shows, stored in scripts/preview-logos/.
let logos = {};
const mark = id => {
  if (!logos[id]) throw new Error(`Missing preview logo: ${id}`);
  return `<img class="mark" src="${logos[id]}" alt="">`;
};

// Cursors drawn inline with a white keyline so they read on any surface.
// Hotspots: the arrow points from its top-left, the I-beam from its centre, the hand from its fingertip.
const cursors = {
  arrow: '<svg class="cursor" width="34" height="46" viewBox="0 0 17 23" aria-hidden="true"><path d="M1 1v17.5l4.4-4.2 2.9 6.9 3.1-1.3-2.9-6.8H14.6Z" fill="#1d1b1a" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  ibeam: '<svg class="cursor" width="22" height="48" viewBox="0 0 11 24" aria-hidden="true"><path d="M2 1.5h2.5c.6 0 1 .4 1 1v19c0 .6-.4 1-1 1H2m7-21H6.5c-.6 0-1 .4-1 1v19c0 .6.4 1 1 1H9" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M2 1.5h2.5c.6 0 1 .4 1 1v19c0 .6-.4 1-1 1H2m7-21H6.5c-.6 0-1 .4-1 1v19c0 .6.4 1 1 1H9" fill="none" stroke="#1d1b1a" stroke-width="1.4" stroke-linecap="round"/></svg>',
  hand: '<svg class="cursor" width="40" height="44" viewBox="0 0 20 22" aria-hidden="true"><path d="M7.2 1.2c1 0 1.7.8 1.7 1.7v6l.1-1.1c.1-.9.9-1.5 1.8-1.4.8.1 1.4.8 1.4 1.6v1.3c.2-.8 1-1.3 1.8-1.2.8.1 1.4.8 1.4 1.6v1.4c.3-.7 1-1.1 1.8-.9.8.2 1.2.9 1.2 1.7v3.9c0 3.4-2.6 6.2-6 6.2H11c-2 0-3.8-1-4.9-2.6L2 11.9c-.5-.8-.3-1.8.5-2.3.7-.4 1.6-.3 2.1.4l.9 1.3V2.9c0-.9.8-1.7 1.7-1.7Z" fill="#fff" stroke="#1d1b1a" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 12.5v4M11.7 12.5v4M14.4 12.5v4" stroke="#1d1b1a" stroke-width="1" stroke-linecap="round"/></svg>',
};

export const conceptStyles = `
.concept{--tone:#f3d3d7;--deep:#a4404f;--ink:#211d1d;background:#f6efef;color:var(--ink)}
.concept.waterfall{--tone:#dcdcf1;--deep:#4f5594;background:#eff0f7}
.concept.attribution{--tone:#d4e8da;--deep:#3f6a4e;background:#eef3ef}
.concept.signals{--tone:#efe0c3;--deep:#86652d;background:#f5f1e8}
.concept:before{content:"";position:absolute;left:700px;top:150px;width:880px;height:740px;background:radial-gradient(ellipse,var(--tone),transparent 69%);filter:blur(12px)}
.concept:after{content:"";position:absolute;width:870px;height:100px;left:640px;top:850px;background:radial-gradient(ellipse,#2c262624,transparent 65%);filter:blur(25px);z-index:0}
.concept .brand{right:80px;top:58px;color:#3a3434;font-size:19px}.concept .brand img{width:31px;height:31px}
.concept .eyebrow{top:70px;left:80px;letter-spacing:1.8px;font-size:15px;color:var(--deep)}
.concept .copy{position:absolute;left:80px;top:280px;width:560px;z-index:2}
.concept .copy h1{position:static;margin:0;font-size:62px;line-height:1.08;letter-spacing:-2px;font-weight:650;white-space:pre-line}
.concept .copy p{font-size:25px;line-height:1.5;color:#6d6767;max-width:450px;margin:28px 0 0}
.ui{position:absolute;z-index:2;background:#fff;border-radius:24px;box-shadow:0 2px 3px #2a1f2008,0 15px 32px -15px #2a1f2030,0 45px 70px -38px #2a1f2050;overflow:hidden;font-size:22px;line-height:1.4;color:#211d1d}
.ui h2,.ui h3,.ui p{margin:0}.ui h2{font-size:30px;line-height:1.2;letter-spacing:-.7px;font-weight:650}.ui h3{font-size:23px;letter-spacing:-.3px;font-weight:600}
.muted{color:#8a8483}.small{font-size:17px}.row{display:flex;align-items:center;gap:14px}.between{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ui .label{font-size:15px;letter-spacing:1.1px;text-transform:uppercase;color:#958f8e;font-weight:600}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:16px;font-weight:550;border-radius:8px;padding:5px 11px;white-space:nowrap}.badge svg{width:15px;height:15px}
.green{background:#e7f3ea;color:#3d6e4b}.amber{background:#f7eedc;color:#8a6a33}.neutral{background:#f3f1ef;color:#6f6a69}.red{background:#fbeaeb;color:#a2434d}
.chip{display:inline-flex;align-items:center;gap:7px;font-size:15px;border-radius:7px;padding:4px 9px;background:#f4f2f1;color:#6f6a69;white-space:nowrap}
.mark{display:block;width:28px;height:28px;border-radius:7px;flex-shrink:0;object-fit:contain}
.cursor{position:absolute;z-index:9;filter:drop-shadow(0 3px 5px #0003)}
.icp-ui{left:680px;top:210px;width:760px;padding:34px 36px 32px;transform:rotate(-2.5deg)}
.icp-field{margin-top:22px;border:2px solid #dd5164;border-radius:14px;padding:18px 20px;font-size:25px;line-height:1.45;min-height:128px;box-shadow:0 0 0 5px #dd516420;position:relative}
.caret{display:inline-block;width:2px;height:30px;background:#211d1d;vertical-align:-5px;margin-left:2px}
.icp-ui .actions{margin-top:22px}.ghost-action{display:inline-flex;align-items:center;gap:8px;font-size:19px;color:#7a7473}
.ink{display:inline-flex;align-items:center;gap:9px;background:#211d1d;color:#fff;border-radius:11px;padding:11px 20px;font-size:20px;font-weight:550}.ink svg{width:19px;height:19px}
.icp-ui .cursor{left:245px;top:56px}
.runs-ui{left:840px;top:522px;width:600px;padding:10px 0;transform:rotate(2.5deg);z-index:4}
.run-row{display:flex;align-items:center;gap:14px;padding:16px 26px;font-size:19px}.run-row+.run-row{border-top:1px solid #f0edec}.run-row .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.run-row>svg{width:20px;height:20px;color:#8a8483;flex-shrink:0}
.wf-ui{left:700px;top:180px;width:720px;padding:0 0 10px;transform:rotate(-2.5deg)}
.wf-head{padding:26px 30px 20px;border-bottom:1px solid #efecea}.wf-head .tile{display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:#f3f1ef;color:#77716f}
.wf-row{display:flex;align-items:center;gap:16px;padding:0 30px;height:68px;border-bottom:1px solid #f1eeec;font-size:22px;font-weight:550;position:relative}
.pos{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#f3f1ef;color:#7a7473;font-size:15px;font-weight:600;flex-shrink:0}
.wf-row .name{flex:1}.arrows{display:flex;gap:6px}.arrow-btn{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;color:#8a8483}.arrow-btn svg{width:21px;height:21px}
.arrow-btn.pressed{background:#e6e4f4;color:#454a8c;box-shadow:inset 0 1px 2px #0000001a}
.wf-row.moving{background:#f5f5fc}.wf-row.moving .pos{background:#dedff3;color:#454a8c}
.wf-row .cursor{left:627px;top:38px}
.note-ui{left:1000px;top:596px;width:470px;padding:26px 30px;transform:rotate(2.5deg);z-index:4}.note-ui p{font-size:19px;margin-top:8px;color:#6d6767}.note-ui .badge{margin-top:16px}
.leads-ui{left:660px;top:200px;width:780px;padding:6px 0 8px;transform:rotate(-2.5deg)}
.lead-row{display:grid;grid-template-columns:1fr 1.25fr auto;gap:18px;align-items:center;padding:18px 30px}.lead-row+.lead-row{border-top:1px solid #f0edec}
.lead-row .who{font-size:21px;font-weight:600}.lead-row .co{font-size:16px;color:#8a8483;margin-top:2px}
.lead-row .email{font-size:18px;color:#3b53b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lead-row .via{margin-top:7px}.lead-row .via .mark{width:18px;height:18px;border-radius:4px}
.dash{color:#bdb7b6;font-size:20px}
.cache-ui{left:990px;top:596px;width:520px;padding:26px 30px;transform:rotate(2.5deg);z-index:4}
.notice{white-space:nowrap;display:flex;align-items:center;gap:12px;background:#e7f3ea;color:#3d6e4b;border-radius:12px;padding:14px 18px;font-size:20px;font-weight:550}.notice svg{width:22px;height:22px;flex-shrink:0}
.cache-ui .chips{display:flex;gap:10px;margin-top:18px}
.sig-ui{left:680px;top:215px;width:760px;padding:34px 36px 36px;transform:rotate(-2.5deg)}
.sig-ui .co-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:#f1ece2;color:#86652d;font-weight:700;font-size:18px}
.sig-ui .summary{font-size:27px;margin-top:22px;letter-spacing:-.3px}
.sig-meta{display:flex;gap:18px;align-items:center;margin-top:16px;font-size:18px;color:#8a8483}
.evidence{display:inline-flex;align-items:center;gap:6px;color:#211d1d;text-decoration:underline;text-underline-offset:4px;text-decoration-thickness:2px;background:#f6eedd;border-radius:6px;padding:2px 6px}.evidence svg{width:17px;height:17px}
.sig-ui .cursor{left:446px;top:222px}
.sig-actions{display:flex;gap:12px;margin-top:26px}.sec-btn{display:inline-flex;align-items:center;border-radius:10px;padding:10px 18px;font-size:19px;font-weight:550;box-shadow:inset 0 0 0 1px #e4e0de}.plain-btn{padding:10px 14px;font-size:19px;color:#7a7473}
.older-ui{left:1010px;top:505px;width:470px;padding:24px 28px;transform:rotate(2.5deg);z-index:4}.older-ui p{font-size:19px;margin-top:10px}
`;

const searches = () => `<section class="ui runs-ui" aria-label="Conceptual list of searches">
  <div class="run-row">${icon('search')}<span class="t">Logistics firms with a new warehouse</span>${badge('Sourcing', 'neutral', 'spinner')}</div>
  <div class="run-row">${icon('search')}<span class="t">Software teams hiring SDRs</span>${chip('12 leads')}${badge('Done', 'green', 'check')}</div>
</section>`;

export const renderCoverPanel = vendorLogos => (logos = vendorLogos) && `<section class="ui cover-panel" aria-label="Conceptual email waterfall">
  <span class="label">Email waterfall</span>
  <div class="cover-step">${mark('findymail')}<span>Findymail</span><span class="muted small">No match</span></div>
  <div class="cover-step">${mark('leadmagic')}<span>LeadMagic</span>${badge('Found', 'green', 'check')}</div>
  <div class="cover-step dim">${mark('anymailfinder')}<span>Anymail Finder</span><span class="muted small">Not needed</span></div>
</section>`;

const concepts = {
  sourcing: () => `<section class="ui icp-ui" aria-label="Conceptual ideal customer profile field">
    <h2>Ideal customer profile</h2>
    <div class="icp-field">Heads of growth at B2B software companies in Berlin hiring their first SDRs<span class="caret"></span>${cursors.ibeam}</div>
    <div class="between actions"><span class="ghost-action">Import CSV</span><span class="ink">Start search ${icon('arrowUp')}</span></div>
  </section>${searches()}`,
  waterfall: () => `<section class="ui wf-ui" aria-label="Conceptual email waterfall order">
    <div class="between wf-head"><div class="row"><span class="tile">${icon('mail')}</span><h2>Email waterfall</h2></div><span class="muted small">Your order</span></div>
    <div class="wf-row"><span class="pos">1</span>${mark('findymail')}<span class="name">Findymail</span><span class="arrows"><span class="arrow-btn">${icon('up')}</span><span class="arrow-btn">${icon('down')}</span></span></div>
    <div class="wf-row moving"><span class="pos">2</span>${mark('hunter')}<span class="name">Hunter</span><span class="arrows"><span class="arrow-btn pressed">${icon('up')}</span><span class="arrow-btn">${icon('down')}</span></span>${cursors.arrow}</div>
    <div class="wf-row"><span class="pos">3</span>${mark('leadmagic')}<span class="name">LeadMagic</span><span class="arrows"><span class="arrow-btn">${icon('up')}</span><span class="arrow-btn">${icon('down')}</span></span></div>
    <div class="wf-row"><span class="pos">4</span>${mark('anymailfinder')}<span class="name">Anymail Finder</span><span class="arrows"><span class="arrow-btn">${icon('up')}</span><span class="arrow-btn">${icon('down')}</span></span></div>
    <div class="wf-row"><span class="pos">5</span>${mark('dropcontact')}<span class="name">Dropcontact</span>${chip('Callback')}<span class="arrows"><span class="arrow-btn">${icon('up')}</span><span class="arrow-btn">${icon('down')}</span></span></div>
  </section><section class="ui note-ui" aria-label="Conceptual waterfall rule"><span class="label">How this runs</span><p>The first verified result wins. The rest of the list is never called.</p>${badge('Verified before delivery', 'green', 'check')}</section>`,
  attribution: () => `<section class="ui leads-ui" aria-label="Conceptual leads with provider attribution">
    <div class="lead-row"><div><div class="who">Maya Okafor</div><div class="co">Lumen Ledger</div></div><div><div class="email">maya.okafor@lumenledger.example</div><div class="via">${chip(`${mark('findymail')}via findymail`)}</div></div>${badge('Found', 'green', 'check')}</div>
    <div class="lead-row"><div><div class="who">Jonas Weber</div><div class="co">Parcelwise</div></div><div><div class="email">jonas@parcelwise.example</div><div class="via">${chip(`${mark('leadmagic')}via leadmagic`)}</div></div>${badge('Found', 'green', 'check')}</div>
    <div class="lead-row"><div><div class="who">Lukas Brandt</div><div class="co">Northwind Metrics</div></div><div><div class="email">l.brandt@northwind.example</div><div class="via">${chip(`${mark('prospeo')}via prospeo`)}</div></div>${badge('Found', 'green', 'check')}</div>
    <div class="lead-row"><div><div class="who">Daniel Osei</div><div class="co">Quillstack</div></div><div><span class="dash">—</span></div>${badge('No match', 'amber')}</div>
  </section><section class="ui cache-ui" aria-label="Conceptual cache result">
    <div class="notice">${icon('database')}Resolved from cache. No credits spent.</div>
    <div class="chips">${chip('12 leads')}${chip('10 credits')}${chip('90-day reuse')}</div>
  </section>`,
  signals: () => `<section class="ui sig-ui" aria-label="Conceptual company signal with evidence">
    <div class="row"><span class="co-mark">P</span><h2>Pinecrest Labs</h2>${chip('hiring')}</div>
    <div class="row" style="margin-top:14px;gap:10px">${badge('2 signals', 'green', 'layers')}${badge('seen 3×', 'amber', 'repeat')}</div>
    <p class="summary">SDR role reposted for the third time</p>
    <div class="sig-meta"><span>3 days ago</span><span>via Company careers page</span><span class="evidence">evidence ${icon('external')}</span></div>
    ${cursors.hand}
    <div class="sig-actions"><span class="sec-btn">Source this</span><span class="plain-btn">Dismiss</span></div>
  </section><section class="ui older-ui" aria-label="Conceptual second signal for the same company">
    <div class="between"><h3>Pinecrest Labs</h3>${chip('funding')}</div>
    <p>Announced a seed round led by a regional fund</p>
    <p class="muted small">9 days ago · via Company news page</p>
  </section>`,
};

export function renderConcept(id, vendorLogos) {
  logos = vendorLogos;
  if (!Object.hasOwn(concepts, id)) throw new Error(`Unknown feature concept: ${id}`);
  return concepts[id]();
}
