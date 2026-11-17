import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

const MODS_SYNTAX = new Set([
  'mods', 'modsxml', 'mods3', 'mods3x', 'mods3.8', 'mods 3.8', 'mods-3.8',
  'http://www.loc.gov/mods/v3', 'info:lc/xmlns/mods/v3',
]);
const MARC_SYNTAX = new Set([
  'marcxml', 'marc21', 'marc21xml', 'marc21-xml', 'marcxml-utf8', 'marcxml utf-8',
  'http://www.loc.gov/marc21/slim', 'info:lc/xmlns/marc21/slim',
]);

function recordError(code, message, detail) {
  return Object.assign(new Error(message), { code, detail });
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attribute(node, name) {
  return node && typeof node === 'object' ? node[`@_${name}`] : undefined;
}

function textOf(node) {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node.trim() || undefined;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = textOf(item);
      if (text) return text;
    }
    return undefined;
  }
  if (typeof node === 'object') {
    if (node['#text'] !== undefined) return String(node['#text']).trim() || undefined;
    for (const key of ['title', 'namePart', 'languageTerm', 'roleTerm']) {
      const text = textOf(node[key]);
      if (text) return text;
    }
  }
  return undefined;
}

function normalizeSyntax(syntax) {
  return String(syntax ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function classifySyntax(syntax) {
  const value = normalizeSyntax(syntax);
  if (!value) return null;
  if (MODS_SYNTAX.has(value)) return 'mods';
  if (MARC_SYNTAX.has(value)) return 'marcxml';
  if (/^mods(?:[ -]?\d+(?:\.\d+)?)?$/.test(value)) return 'mods';
  if (/^marc(?:21)?[ -]?xml(?:[ -]?utf-?8)?$/.test(value)) return 'marcxml';
  return null;
}

function trimPunctuation(value) {
  return String(value).replace(/\s*[/:;,=]+\s*$/u, '').trim();
}

function parseModsIdentifier(root) {
  const identifiers = asArray(root.identifier)
    .map(item => ({ type: attribute(item, 'type') || null, value: textOf(item) }))
    .filter(item => item.value);
  if (identifiers.length === 0) return null;
  const local = identifiers.find(item => String(item.type || '').toLowerCase() === 'local');
  const chosen = local || identifiers[0];
  return {
    identity: { scheme: `mods:${String(chosen.type || 'identifier').toLowerCase()}`, value: chosen.value },
    identifiers,
  };
}

function parseMods(root) {
  const titles = asArray(root.titleInfo);
  const primary = titles.find(item => attribute(item, 'type') === 'primary') || titles[0];
  const nonSort = textOf(primary?.nonSort);
  const titleText = textOf(primary?.title);
  const subTitle = textOf(primary?.subTitle);
  const title = titleText
    ? `${nonSort || ''}${titleText}${subTitle ? ` : ${subTitle}` : ''}`
    : undefined;

  const identity = parseModsIdentifier(root);
  if (!identity) throw recordError('missing-identity', '记录缺少正文标识，无法建立稳定身份');

  const creators = asArray(root.name).map(name => {
    const parts = asArray(name.namePart).map(textOf).filter(Boolean);
    if (parts.length === 0) return null;
    const role = textOf(asArray(name.role).map(item => item.roleTerm)) || undefined;
    return { name: parts.join(' '), type: attribute(name, 'type') || undefined, role };
  }).filter(Boolean);

  const origin = asArray(root.originInfo)[0];
  const publisher = origin ? textOf(origin.publisher) : undefined;
  const date = origin ? textOf(origin.dateIssued) : undefined;
  const languageNode = asArray(root.language)[0];
  const languageTerm = languageNode ? asArray(languageNode.languageTerm)[0] : undefined;
  const language = textOf(languageTerm) || attribute(languageTerm, 'code') || undefined;
  const physical = asArray(root.physicalDescription)[0];
  const extent = physical ? textOf(physical.extent) : undefined;
  const form = physical ? textOf(physical.form) : undefined;

  const record = { identity: identity.identity, title };
  if (identity.identifiers.length > 1) record.identifiers = identity.identifiers;
  if (creators.length) record.creators = creators;
  if (publisher) record.publisher = publisher;
  if (date) record.date = date;
  if (language) record.language = language;
  if (extent) record.extent = extent;
  if (form) record.form = form;
  return record;
}

function marcSubfields(datafields, tag) {
  return datafields
    .filter(field => attribute(field, 'tag') === tag)
    .flatMap(field => asArray(field.subfield))
    .map(subfield => ({ code: attribute(subfield, 'code'), value: textOf(subfield) }))
    .filter(subfield => subfield.value);
}

function marcControlfield(controlfields, tag) {
  const field = controlfields.find(item => attribute(item, 'tag') === tag);
  return field ? textOf(field) : undefined;
}

function parseMarcRecord(record) {
  const controlfields = asArray(record.controlfield);
  const datafields = asArray(record.datafield);
  const leader = textOf(record.leader);

  const controlNumber = marcControlfield(controlfields, '001');
  const isbn = marcSubfields(datafields, '020').find(field => field.code === 'a')?.value;
  const issn = marcSubfields(datafields, '022').find(field => field.code === 'a')?.value;
  const lccn = marcSubfields(datafields, '010').find(field => field.code === 'a')?.value;
  const identity = controlNumber
    ? { scheme: 'marc:001', value: controlNumber }
    : lccn
      ? { scheme: 'marc:010', value: lccn }
      : isbn
        ? { scheme: 'marc:020', value: isbn }
        : null;
  if (!identity) throw recordError('missing-identity', '记录缺少正文标识，无法建立稳定身份');

  const titleField = datafields.find(field => attribute(field, 'tag') === '245');
  const titleParts = titleField
    ? asArray(titleField.subfield)
      .filter(subfield => ['a', 'b', 'n', 'p'].includes(attribute(subfield, 'code')))
      .map(textOf)
      .filter(Boolean)
      .map(trimPunctuation)
    : [];
  const title = titleParts.length ? titleParts.join(' ') : undefined;

  const creator = ['100', '110', '111']
    .map(tag => marcSubfields(datafields, tag)[0]?.value)
    .find(Boolean);
  const publisherField = ['260', '264']
    .map(tag => marcSubfields(datafields, tag))
    .find(fields => fields.length);
  const publisher = publisherField?.find(field => field.code === 'b')?.value;
  const date = publisherField?.find(field => field.code === 'c')?.value?.replace(/\.$/u, '') || undefined;
  const edition = marcSubfields(datafields, '250')[0]?.value;
  const language = marcControlfield(controlfields, '008')?.slice(35, 38)?.trim()
    || marcSubfields(datafields, '041').find(field => field.code === 'a')?.value;

  const record_ = { identity, title };
  if (creator) record_.creators = [{ name: creator }];
  if (publisher) record_.publisher = publisher;
  if (date) record_.date = date;
  if (edition) record_.edition = edition;
  if (language) record_.language = language;
  const identifiers = { controlNumber, isbn, issn, lccn };
  if (Object.values(identifiers).some(Boolean)) record_.identifiers = identifiers;
  return record_;
}

function parseMarcXml(document) {
  if (document.collection !== undefined) {
    const records = asArray(document.collection.record);
    if (records.length === 0) throw recordError('malformed-record', 'MARCXML 记录正文为空');
    if (records.length > 1) throw recordError('ambiguous-record', 'MARCXML 条目包含多条记录，无法确定对应关系');
    return parseMarcRecord(records[0]);
  }
  if (document.record !== undefined) return parseMarcRecord(document.record);
  throw recordError('malformed-record', '记录根元素不是 MARCXML record/collection');
}

/**
 * Convert one gateway retrievalRecord into presentable bibliographic fields.
 * Diagnostic entries are intentionally not passed here: only retrievalRecord
 * bodies may become catalogue records.
 */
export function parseRetrievalRecord(retrievalRecord) {
  if (!retrievalRecord || typeof retrievalRecord !== 'object') {
    throw recordError('invalid-record', '来源返回了无法识别的条目');
  }
  const raw = typeof retrievalRecord.body === 'string' ? retrievalRecord.body : null;
  if (!raw || !raw.trim()) throw recordError('empty-record', '记录正文为空');

  const validation = XMLValidator.validate(raw);
  if (validation !== true) {
    throw recordError('malformed-record', `记录不是格式良好的 XML：${validation.err?.msg || '解析失败'}`);
  }

  let document;
  try {
    document = parser.parse(raw);
  } catch (error) {
    throw recordError('malformed-record', `记录无法解析：${error.message}`);
  }
  if (!document || typeof document !== 'object') {
    throw recordError('malformed-record', '记录无法解析');
  }

  const declared = classifySyntax(retrievalRecord.syntax);
  const root = Object.keys(document)[0];
  const syntax = declared
    || (root === 'mods' ? 'mods' : (root === 'collection' || root === 'record') ? 'marcxml' : null);
  if (!syntax) {
    throw recordError('unsupported-syntax', `该条目呈现格式不受支持：${retrievalRecord.syntax ?? root ?? '未知'}`);
  }

  try {
    const parsed = syntax === 'mods'
      ? (root === 'mods' ? parseMods(document.mods) : (() => { throw recordError('malformed-record', '记录根元素与声明的 MODS 格式不一致'); })())
      : (root === 'collection' || root === 'record'
        ? parseMarcXml(document)
        : (() => { throw recordError('malformed-record', '记录根元素与声明的 MARCXML 格式不一致'); })());
    return { syntax, declaredSyntax: retrievalRecord.syntax ?? null, ...parsed };
  } catch (error) {
    if (error.code) throw error;
    throw recordError('malformed-record', `记录无法解析：${error.message}`);
  }
}
