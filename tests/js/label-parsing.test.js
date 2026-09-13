/* Label parsing, pinned to the real hardware.
 *
 * Run directly:  node tests/js/label-parsing.test.js
 * (tests/test_label_parsing.py runs it too, and skips if node is absent.)
 *
 * Every case below is text shaped like what Apple Vision returns for a label
 * actually seen in the field. Two separate misreads have shipped here — MAC
 * formats, then a GS7 gateway classified as an ONT because both labels print
 * "Part No." — and each one put a router's MAC in the ONT slot, which is the
 * kind of wrong that reaches a work order. Add a case here whenever new
 * hardware turns up. */
const fs = require('fs');

const path = require('path');
const SCANNER = path.join(__dirname, '..', '..', 'static', 'js', 'scanner.js');
const src = fs.readFileSync(SCANNER, 'utf8');
const start = src.indexOf('const ROUTER_MARKERS');
const marker = '\n  return template;\n}';
const end = src.indexOf(marker, start) + marker.length;
if (start < 0 || end < marker.length) throw new Error('could not locate parser');
// Pull the whole parsing unit — markers, classifier and formatter — so the
// test always exercises the shipped source rather than a copy of it.
const parse = eval(`(function () { ${src.slice(start, end)}
  return formatOcrToTemplate; })()`);

// --- the three real labels, as Vision reads them (line per printed line) ---
const ONT = `PART NO.: 100-05857
REV: 11
PROD DESC:
GP1101X XGS-PON ONT
Serial NO.: 542506033321
SW VERSION: 24.2.0.0.40
FSAN: CXNK01C7B040
ONU MAC: 1074C5FA1518
MTA MAC: 1074C5FA1519
CLEI NO.:
BVMNM00ARB
COUNTRY OF ORIGIN: VNM`;

const ROUTER_U6 = `MODEL NO: 100-06062
REV: 10
PROD DESC: GigaSpire BLAST
Model:u6.3 GS4229E
SERIAL NO: 632508041103
SW VERSION: 25.1.500.348
SSID: CXNK01C0DC59
MAC: 1074C50DFFA5
MTA MAC: 1074C50DFFA6
COUNTRY OF ORIGIN: VNM
CLEI NO: BVMKN00DRA`;

const ROUTER_GS7 = `GS7 10GE Tri Gateway
Model: GS7 10GE GS5239E
Part No.: 100-05969 11
300-Level No.:300-03046 12
Serial No.: 662510187977
MAC: 1074C5BD26D7
MTA MAC: 1074C5BD26D8
FSAN/SSID: CXNK01D23AAC
WPA KEY: 215869788ef776c4
IP Address: 192.168.1.1
User: admin
Password: 78c40053
BVMNG10ARB
UL LISTED E207975
RoHS COMPLIANT`;

const field = (out, section, name) => {
  const half = section === 'ONT'
    ? out.split('ROUTER INFO')[0]
    : out.split('ROUTER INFO')[1];
  const m = half.match(new RegExp(`^${name} = (.*)$`, 'm'));
  return (m ? m[1] : '').trim();
};

const CASES = [
  {
    name: 'ONT only',
    texts: [ONT],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '', routerFsan: '' },
  },
  {
    name: 'ONT + u6.3 GigaSpire',
    texts: [ONT, ROUTER_U6],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '1074C50DFFA5', routerFsan: 'CXNK01C0DC59' },
  },
  {
    name: 'ONT + GS7 10GE Tri Gateway',
    texts: [ONT, ROUTER_GS7],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '1074C5BD26D7', routerFsan: 'CXNK01D23AAC' },
  },
  {
    name: 'GS7 photographed first, ONT second',
    texts: [ROUTER_GS7, ONT],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '1074C5BD26D7', routerFsan: 'CXNK01D23AAC' },
  },
  {
    name: 'GS7 only',
    texts: [ROUTER_GS7],
    want: { ontMac: '', ontMta: '', ontFsan: '', ontSn: '',
            routerMac: '1074C5BD26D7', routerFsan: 'CXNK01D23AAC' },
  },
  {
    name: 'u6.3 only',
    texts: [ROUTER_U6],
    want: { ontMac: '', ontMta: '', ontFsan: '', ontSn: '',
            routerMac: '1074C50DFFA5', routerFsan: 'CXNK01C0DC59' },
  },
  {
    // Model line lost to glare — only the credential block survives. Still a
    // router, because ONTs never carry an SSID or a wifi password.
    name: 'ONT + gateway with the model line unreadable',
    texts: [ONT, `Serial No.: 662510187977
MAC: 1074C5BD26D7
MTA MAC: 1074C5BD26D8
FSAN/SSID: CXNK01D23AAC
WPA KEY: 215869788ef776c4
IP Address: 192.168.1.1`],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '1074C5BD26D7', routerFsan: 'CXNK01D23AAC' },
  },
  {
    // No family markers at all on the second photo. The ONT is already filled,
    // so the leftover belongs to the router rather than overwriting the ONT.
    name: 'ONT + unidentifiable second label',
    texts: [ONT, `MAC: 1074C5BD26D7
FSAN: CXNK01D23AAC`],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '1074C5BD26D7', routerFsan: 'CXNK01D23AAC' },
  },
  {
    // A reshoot that came out blank must not wipe what the good photo read.
    name: 'ONT + a blurry retake that reads nothing',
    texts: [ONT, 'blurry glare nothing legible here'],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '', routerFsan: '' },
  },
  {
    // All three, one job.
    name: 'ONT + u6.3 + GS7 (u6.3 first)',
    texts: [ONT, ROUTER_U6, ROUTER_GS7],
    want: { ontMac: '1074C5FA1518', ontMta: '1074C5FA1519', ontFsan: 'CXNK01C7B040',
            ontSn: '542506033321', routerMac: '1074C50DFFA5', routerFsan: 'CXNK01C0DC59' },
  },
];

let failures = 0;
for (const c of CASES) {
  const out = parse(c.texts);
  const got = {
    ontMac: field(out, 'ONT', 'MAC'),
    ontMta: field(out, 'ONT', 'MTA MAC'),
    ontFsan: field(out, 'ONT', 'FSAN'),
    ontSn: field(out, 'ONT', 'S/N'),
    routerMac: field(out, 'ROUTER', 'MAC'),
    routerFsan: field(out, 'ROUTER', 'FSAN'),
  };
  const bad = Object.keys(c.want).filter((k) => got[k] !== c.want[k]);
  if (bad.length) {
    failures++;
    console.log(`FAIL  ${c.name}`);
    for (const k of bad) console.log(`        ${k}: got "${got[k]}"  want "${c.want[k]}"`);
  } else {
    console.log(`pass  ${c.name}`);
  }
}
console.log(failures ? `\n${failures} case(s) failing` : '\nall cases pass');

process.exit(failures ? 1 : 0);
