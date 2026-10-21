// ---------------------------------------------------------------------------
// workflowMapping.js  (server-side, modul selfie / pap)
// Memetakan node workflow ComfyUI (format API) ke peran logis lewat
// selfie.mapping.json: cocokkan _meta.title (persis -> terpotong), cadangan class_type.
// Semua kegagalan menyebut PERSIS apa yang harus diisi di selfie.mapping.json.
// ---------------------------------------------------------------------------
import { ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';

const MIN_PREFIX_LEN = 5;
const norm = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();
const titleOf = (node) => node?._meta?.title ?? '';

function mappingError(msg) {
  return new ImageProviderError(IMAGE_ERROR.MAPPING, `selfie.mapping.json: ${msg}`);
}

function describeNode(id, node) {
  return `[${id}] ${node.class_type} "${titleOf(node)}"`;
}

/** Cari tepat satu node untuk peran `role`. */
function findNode(workflow, role, spec) {
  const entries = Object.entries(workflow);
  let matches = [];
  let how = '';

  if (spec.title) {
    matches = entries.filter(([, n]) => titleOf(n) === spec.title);
    how = 'judul persis';
    if (matches.length === 0) {
      const t = norm(spec.title);
      matches = entries.filter(([, n]) => {
        const x = norm(titleOf(n));
        return x.length >= MIN_PREFIX_LEN && (x.startsWith(t) || t.startsWith(x));
      });
      how = 'judul terpotong';
    }
  }
  if (matches.length === 0 && spec.classType) {
    matches = entries.filter(([, n]) => n.class_type === spec.classType);
    how = `class_type ${spec.classType}`;
  }

  if (matches.length === 0) {
    const titles = entries.map(([id, n]) => `  ${describeNode(id, n)}`).join('\n');
    throw mappingError(
      `node untuk peran "${role}" tidak ditemukan (title="${spec.title ?? ''}", classType="${spec.classType ?? ''}"). ` +
        `Isi nodes.${role}.title dengan salah satu judul persis berikut dari workflow:\n${titles}`,
    );
  }
  if (matches.length > 1) {
    const list = matches.map(([id, n]) => `  ${describeNode(id, n)}`).join('\n');
    throw mappingError(
      `node untuk peran "${role}" ambigu (${matches.length} kandidat via ${how}). ` +
        `Perjelas nodes.${role}.title agar hanya cocok dengan satu node:\n${list}`,
    );
  }
  return { id: matches[0][0], node: matches[0][1], how };
}

/**
 * @returns {{ [role: string]: { id: string, classType: string, title: string, how: string, fields: Record<string,string> } }}
 */
export function resolveMapping(workflow, mapping) {
  const nodes = mapping?.nodes;
  if (!nodes || typeof nodes !== 'object') {
    throw mappingError('properti "nodes" tidak ada.');
  }
  const required = {
    prompt: ['positive', 'negative', 'resolution'],
    reference: ['image'],
    sampler: ['seed', 'steps'],
    save: ['filenamePrefix'],
  };
  const resolved = {};
  for (const [role, fieldKeys] of Object.entries(required)) {
    const spec = nodes[role];
    if (!spec) throw mappingError(`peran "nodes.${role}" belum diisi.`);
    const { id, node, how } = findNode(workflow, role, spec);
    const fields = {};
    for (const key of fieldKeys) {
      const inputName = spec.fields?.[key];
      if (!inputName) {
        throw mappingError(`nodes.${role}.fields.${key} belum diisi (nama field input pada node ${describeNode(id, node)}).`);
      }
      const inputs = node.inputs ?? {};
      if (!(inputName in inputs)) {
        throw mappingError(
          `nodes.${role}.fields.${key}="${inputName}" tidak ada di node ${describeNode(id, node)}. ` +
            `Field yang tersedia: ${Object.keys(inputs).join(', ') || '(kosong)'}`,
        );
      }
      if (Array.isArray(inputs[inputName])) {
        throw mappingError(
          `nodes.${role}.fields.${key}="${inputName}" pada node ${describeNode(id, node)} berisi link ke node lain, bukan nilai. ` +
            `Pilih field lain yang berisi nilai langsung.`,
        );
      }
      fields[key] = inputName;
    }
    resolved[role] = { id, classType: node.class_type, title: titleOf(node), how, fields };
  }
  return resolved;
}

/** Cetak daftar node workflow + hasil deteksi mapping. */
export function describeDetection(workflow, resolved, log) {
  log('Node workflow terdeteksi:');
  for (const [id, node] of Object.entries(workflow)) {
    const fields = Object.entries(node.inputs ?? {})
      .filter(([, v]) => !Array.isArray(v))
      .map(([k]) => k)
      .join(', ');
    log(`  ${describeNode(id, node)}  fields: ${fields || '-'}`);
  }
  log('Pemetaan peran -> node:');
  for (const [role, r] of Object.entries(resolved)) {
    const f = Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join(', ');
    log(`  ${role} -> [${r.id}] ${r.classType} "${r.title}" (${r.how}) { ${f} }`);
  }
}
