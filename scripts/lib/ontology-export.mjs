// What a sealed release carries beside the schema itself, both derived from it:
// the row format of the sealed data files, and the schema in a standard form
// (RDFS/OWL for classes and properties, SKOS for vocabularies, SHACL for the
// cardinalities and value lists). Nothing in the pipeline reads either; they
// exist so the schema can be checked against, and handed to, tools that do not
// know our JSON.
import { schema as currentSchema } from "./ontology-schema.mjs";

const XSD = {
  string: "xsd:string", text: "xsd:string", boolean: "xsd:boolean", integer: "xsd:integer",
  number: "xsd:decimal", date: "xsd:date", datetime: "xsd:dateTime", uri: "xsd:anyURI",
};

const literal = (text, language) =>
  `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"` +
  (language ? `@${language.toLowerCase()}` : "");

/** Both languages of a bilingual field as `predicate "…"@en, "…"@zh-cn`. */
function bilingual(predicate, value) {
  const parts = Object.entries(value ?? {}).filter(([, text]) => text).map(([language, text]) => literal(text, language));
  return parts.length ? [`${predicate} ${parts.join(", ")}`] : [];
}

export function iris(schema = currentSchema) {
  const base = schema.namespace;
  const safe = (text) => encodeURIComponent(String(text));
  return {
    ontology: `<${base.replace(/#$/, "")}>`,
    class: (name) => `<${base}${safe(name)}>`,
    property: (key) => `<${base}${key.split(".").map(safe).join("/")}>`,
    relation: (name) => `<${base}relation/${safe(name)}>`,
    scheme: (name) => `<${base}vocabulary/${safe(name)}>`,
    term: (name, id) => `<${base}vocabulary/${safe(name)}/${safe(id)}>`,
    shape: (name) => `<${base}shape/${safe(name)}>`,
  };
}

/** The schema as Turtle. Deterministic: same schema in, same text out. */
export function toTurtle(schema = currentSchema) {
  const iri = iris(schema);
  const out = [
    "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
    "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
    "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .",
    "@prefix sh: <http://www.w3.org/ns/shacl#> .",
    "",
  ];
  const block = (subject, lines) => out.push(`${subject}\n  ${lines.join(" ;\n  ")} .`, "");
  const termIdsOf = (name) => Object.keys(schema.vocabularies[name].terms);

  block(iri.ontology, [
    "a owl:Ontology", `rdfs:label ${literal(schema.ontology)}`, `owl:versionInfo ${literal(schema.version)}`,
    ...bilingual("rdfs:comment", schema.note),
  ]);

  for (const [name, body] of Object.entries(schema.classes)) {
    block(iri.class(name), [
      "a owl:Class", ...bilingual("rdfs:label", body.label), ...bilingual("rdfs:comment", body.definition),
      ...(body.subclass_of ? [`rdfs:subClassOf ${iri.class(body.subclass_of)}`] : []),
    ]);
  }

  const shapes = new Map(Object.keys(schema.classes).map((name) => [name, []]));
  for (const [key, body] of Object.entries(schema.properties)) {
    const lines = [...bilingual("rdfs:comment", body.definition), `rdfs:domain ${iri.class(body.domain)}`];
    const constraint = [`sh:path ${iri.property(key)}`, `sh:minCount ${body.min}`];
    if (body.max === 1) constraint.push("sh:maxCount 1");
    if (body.range.startsWith("class:")) {
      lines.unshift("a owl:ObjectProperty");
      lines.push(`rdfs:range ${iri.class(body.range.slice(6))}`);
      constraint.push(`sh:class ${iri.class(body.range.slice(6))}`);
    } else if (body.range.startsWith("vocabulary:")) {
      const vocabulary = body.range.slice(11);
      lines.unshift("a owl:ObjectProperty");
      lines.push("rdfs:range skos:Concept");
      constraint.push(`sh:in ( ${termIdsOf(vocabulary).map((id) => iri.term(vocabulary, id)).join(" ")} )`);
    } else {
      lines.unshift("a owl:DatatypeProperty");
      if (XSD[body.range]) {
        lines.push(`rdfs:range ${XSD[body.range]}`);
        constraint.push(`sh:datatype ${XSD[body.range]}`);
      }
    }
    block(iri.property(key), lines);
    shapes.get(body.domain).push(`sh:property [ ${constraint.join(" ; ")} ]`);
  }

  for (const [name, body] of Object.entries(schema.relations)) {
    const ends = (value) => {
      const list = [value].flat().filter((end) => !String(end).startsWith("external:"));
      if (!list.length) return null;
      return list.length === 1 ? iri.class(list[0]) : `[ a owl:Class ; owl:unionOf ( ${list.map(iri.class).join(" ")} ) ]`;
    };
    const range = ends(body.range);
    block(iri.relation(name), [
      "a owl:ObjectProperty", ...bilingual("rdfs:label", body.label), ...bilingual("rdfs:comment", body.definition),
      `rdfs:domain ${ends(body.domain)}`, ...(range ? [`rdfs:range ${range}`] : []),
    ]);
  }

  for (const [name, body] of Object.entries(schema.vocabularies)) {
    block(iri.scheme(name), [
      "a skos:ConceptScheme", ...bilingual("skos:prefLabel", body.label),
      ...(body.version ? [`owl:versionInfo ${literal(body.version)}`] : []),
      ...(body.retired ? ["owl:deprecated true"] : []),
    ]);
    for (const [id, term] of Object.entries(body.terms)) {
      block(iri.term(name, id), [
        "a skos:Concept", `skos:inScheme ${iri.scheme(name)}`, `skos:notation ${literal(id)}`,
        ...bilingual("skos:prefLabel", term.label), ...bilingual("skos:definition", term.definition),
      ]);
    }
  }

  for (const [name, properties] of shapes) {
    if (properties.length) block(iri.shape(name), ["a sh:NodeShape", `sh:targetClass ${iri.class(name)}`, ...properties]);
  }
  return out.join("\n");
}

/** How many of each thing a faithful export must contain. */
export function exportCounts(schema = currentSchema) {
  return {
    classes: Object.keys(schema.classes).length,
    properties: Object.keys(schema.properties).length,
    relations: Object.keys(schema.relations).length,
    vocabularies: Object.keys(schema.vocabularies).length,
    terms: Object.values(schema.vocabularies).reduce((n, body) => n + Object.keys(body.terms).length, 0),
  };
}

const TYPES = {
  string: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 }, boolean: { type: "boolean" },
  integer: { type: "integer" }, number: { type: "number" }, date: { type: "string", format: "date" },
  datetime: { type: "string", format: "date-time" }, uri: { type: "string", format: "uri" },
};

/** JSON Schema for a range: a datatype, a vocabulary's terms, or another entity's id. */
function rangeFormat(range, schema) {
  if (range.startsWith("vocabulary:")) return { enum: Object.keys(schema.vocabularies[range.slice(11)].terms) };
  if (range.startsWith("class:")) return TYPES.string;
  return TYPES[range];
}

/**
 * The row format of the sealed data files (JSON Schema 2020-12).
 *
 * Concepts, relations and external mappings are generated from the schema's
 * classes, relations and vocabularies. The reference_* collections, sources and
 * coverage are source material copied from an external system, not classes of
 * this ontology; their format is inherited unchanged from the previous release.
 */
export function dataFormat(schema, inherited) {
  const nullable = (format) => ({ anyOf: [format, { type: "null" }] });
  const object = (properties, optional = []) => ({
    type: "object", properties,
    required: Object.keys(properties).filter((name) => !optional.includes(name)),
    additionalProperties: false,
  });
  const concept = {};
  const absent = [];
  for (const [key, body] of Object.entries(schema.properties)) {
    if (body.domain !== "Concept") continue;
    const name = key.split(".")[1];
    let format = rangeFormat(body.range, schema);
    if (body.range === "object") {
      format = object(Object.fromEntries(Object.entries(body.fields).map(([field, range]) =>
        [field, field === "language" ? { enum: ["en", "zh-CN"] } : rangeFormat(range, schema)])));
    }
    // An optional property is null in the file when it has a column, and left out when it has none.
    if (body.min === 0 && body.column) format = nullable(format);
    if (body.min === 0 && !body.column) absent.push(name);
    concept[name] = format;
  }
  const sealed = Object.entries(schema.relations).filter(([, body]) => body.storage === "sealed:relations.jsonl");
  const mapping = schema.relations.mapped_to.attributes;
  const array = (items) => ({ type: "array", items });
  const rows = {
    ...inherited.properties,
    concepts: array(object(concept, absent)),
    relations: array(object({
      id: TYPES.string, kind: { enum: sealed.map(([name]) => name) },
      view: { enum: [...new Set(sealed.map(([, body]) => body.view))] },
      parent_id: TYPES.string, child_id: TYPES.string, order: { type: "integer", minimum: 0 },
    })),
    external_mappings: array(object({
      id: TYPES.string, concept_id: TYPES.string, source_id: TYPES.string,
      external_type: { enum: Object.keys(schema.external_types) }, external_id: TYPES.string,
      relation: rangeFormat(mapping.relation, schema), method: rangeFormat(mapping.method, schema),
      status: rangeFormat(mapping.status, schema), explanation: TYPES.string,
    }, ["explanation"])),
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://openaiwill.com/schemas/ontology/${schema.version}/data-format.json`,
    title: `openaiwill ontology ${schema.version} data format`,
    type: "object", properties: rows, required: Object.keys(rows), additionalProperties: false,
  };
}
