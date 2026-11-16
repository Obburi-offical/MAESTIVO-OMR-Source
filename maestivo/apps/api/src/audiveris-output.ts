import { DOMParser, type Element } from "@xmldom/xmldom";
import { unzipSync, zipSync, type Zippable } from "fflate";

const scoreName = "score-partwise";
const containerName = "META-INF/container.xml";
const maxExpandedBytes = 20 * 1024 * 1024;
const maxArchiveEntries = 80;
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const inspect = new TextDecoder();
const encode = new TextEncoder();

const invalid = () => new Error("Invalid Audiveris score metadata");
const privateLocation = () => new Error("Audiveris output contains private worker metadata");

function children(parent: Element, tagName: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (node): node is Element => node.nodeType === 1 && (node as Element).localName === tagName,
  );
}

function parse(xml: string, expectedRoot: string) {
  try {
    // Keep the original CR/LF offsets available for exact text replacement.
    // This parser does not fetch a document's external DTD.
    const doc = new DOMParser({
      normalizeLineEndings: (source) => source,
      onError: () => { throw invalid(); },
    }).parseFromString(xml, "application/xml");
    if (doc.documentElement?.localName !== expectedRoot) throw invalid();
    return doc.documentElement;
  } catch {
    throw invalid();
  }
}

function xmlReferences(text: string) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[\da-fA-F]{1,6});/g, (match) => {
    switch (match) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": return "'";
    }
    const hex = match[2] === "x";
    const point = Number.parseInt(match.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function rejectPrivateText(text: string, markers: readonly string[]) {
  const decoded = text.includes("&") ? xmlReferences(text) : text;
  if (markers.some((marker) => text.includes(marker) || decoded.includes(marker))) throw privateLocation();
}

function sanitizeXml(bytes: Uint8Array, locations: readonly string[], markers: readonly string[]) {
  const xml = decode.decode(bytes);
  const root = parse(xml, scoreName);
  const sources = children(root, "identification").flatMap((identification) => [
    ...children(identification, "source"),
    ...children(identification, "miscellaneous").flatMap((miscellaneous) =>
      children(miscellaneous, "miscellaneous-field").filter((field) => field.getAttribute("name") === "source-file")),
  ]);
  const matching = sources.filter((field) => locations.includes(field.textContent ?? ""));
  const lines = [0];
  if (matching.length) {
    for (const line of xml.matchAll(/\r\n?|\n/g)) lines.push(line.index! + line[0].length);
  }
  const edits = matching.map((field) => {
    const start = lines[(field.lineNumber ?? 0) - 1] + (field.columnNumber ?? 0) - 1;
    if (!Number.isSafeInteger(start) || start < 0) throw invalid();
    const opening = /^<([^\s/<>"']+)(?:[^<>"']|"[^"]*"|'[^']*')*>/.exec(xml.slice(start));
    if (opening?.[1] !== field.tagName || !Array.from(field.childNodes).every((node) => node.nodeType === 3)) throw invalid();
    const from = start + opening[0].length;
    const to = xml.indexOf("<", from);
    if (to < from || !xml.startsWith(`</${field.tagName}`, to) ||
        xmlReferences(xml.slice(from, to)) !== field.textContent) throw invalid();
    return { from, to };
  });
  let sanitized = xml;
  for (const { from, to } of edits.sort((left, right) => right.from - left.from))
    sanitized = sanitized.slice(0, from) + "input.pdf" + sanitized.slice(to);
  rejectPrivateText(sanitized, markers);
  return edits.length ? encode.encode(sanitized) : bytes;
}

function cleanMemberName(name: string) {
  return name !== "__proto__" && name.length > 0 && !/^[\\/]|[\\\x00-\x1f]|(^|\/)\.\.?($|\/)/.test(name);
}

function rootMember(files: Record<string, Uint8Array>) {
  const container = files[containerName];
  if (container) {
    const root = parse(decode.decode(container), "container");
    const files = children(root, "rootfiles");
    const roots = files.length === 1 ? children(files[0], "rootfile") : [];
    const path = roots[0]?.getAttribute("full-path");
    if (roots.length !== 1 || !path || !cleanMemberName(path)) throw invalid();
    return path;
  }
  const roots = Object.keys(files).filter((name) => /\.(?:xml|musicxml)$/i.test(name) && !name.startsWith("META-INF/"));
  if (roots.length !== 1) throw invalid();
  return roots[0];
}

/** Supply the requested and canonical path plus the unique scratch attempt directory name. */
export function sanitizeAudiverisOutput(
  bytes: Uint8Array,
  extension: string,
  locations: readonly string[],
  attemptName: string,
) {
  const markers = [...locations, attemptName];
  if (extension !== ".mxl") return sanitizeXml(bytes, locations, markers);

  const members = new Map<string, { size: number; compression: number }>();
  let expanded = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      expanded += entry.originalSize;
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > bytes.byteLength ||
          members.size >= maxArchiveEntries || expanded > maxExpandedBytes ||
          members.has(entry.name) || !cleanMemberName(entry.name)) throw invalid();
      rejectPrivateText(entry.name, markers);
      members.set(entry.name, { size: entry.originalSize, compression: entry.compression });
      return true;
    },
  });
  const root = rootMember(files);
  if (!Object.hasOwn(files, root)) throw invalid();

  const sanitized = sanitizeXml(files[root], locations, markers);
  const outputs: Zippable = Object.create(null);
  for (const [name, entry] of members) {
    const member = files[name];
    if (!member || member.byteLength !== entry.size) throw invalid();
    // Binary resources retain their bytes. This check reads text only to look
    // for the short, per-job identifier or a known generated path.
    if (name !== root) rejectPrivateText(inspect.decode(member), markers);
    outputs[name] = [name === root ? sanitized : member, { level: entry.compression === 0 ? 0 : 6 }];
  }
  const result = sanitized !== files[root] ? zipSync(outputs) : bytes;
  // Also cover uncompressed ZIP headers, extra fields and archive comments.
  rejectPrivateText(inspect.decode(result), markers);
  return result;
}
