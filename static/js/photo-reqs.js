/* Required validation photos per charge code, from the contractor rate sheet.
   All photos must be timestamped. Shared by the job form and photo compressor. */

export const PHOTO_REQS = {
  'R1': ['ONT and router placement', 'Wall entry point', 'Speedtest', 'Light level at ONT'],
  'A1': ['Each attachment point', 'Wire run to NID', 'Documentation of route taken'],
  'D2': ['Light reading at NID after burial', 'Burial route', 'Structure', 'NID with riser guard'],
  'D6': ['Mule string at start of conduit', 'Mule string at end of conduit', 'Cable in/out of conduit (match entered length)'],
  'D5': ['Photo of location'],
  'D7': ['NID mounting with riser guard', 'Inside of the NID'],
  'D8': ['Splice case (if in terminal)', 'Power meter showing passing light at NID'],
  'D11': ['Path of drop', 'Beginning of temp drop', 'End of temp drop'],
  'D10': [],
};

export function codeOf(itemName) {
  const m = /^(R1|A1|D2|D6|D5|D7|D8|D11|D10)\b/.exec(itemName || '');
  return m ? m[1] : null;
}

/* items: { 'R1 – ...': qty, ... } -> { total, detail: [{code, name, photos}] } */
export function requiredPhotos(items) {
  let total = 0;
  const detail = [];
  for (const name of Object.keys(items || {})) {
    const code = codeOf(name);
    const photos = code ? (PHOTO_REQS[code] || []) : [];
    if (photos.length) {
      total += photos.length;
      detail.push({ code, name, photos });
    }
  }
  return { total, detail };
}

/* Flatten to a numbered list: [{n, code, name}] */
export function photoChecklist(items) {
  const { detail } = requiredPhotos(items);
  const list = [];
  let n = 1;
  for (const d of detail) {
    for (const p of d.photos) list.push({ n: n++, code: d.code, name: p });
  }
  return list;
}
