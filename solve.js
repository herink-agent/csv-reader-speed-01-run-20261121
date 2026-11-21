// solve.js — a fast drop-in for make.fun's csv-reader 1.0.0.
//
// Semantics (from the competition spec, "Read broken CSV files faster"):
// - Text is read once, left to right. A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field that opens with a quote runs to the next quote that is not
//   doubled ("" inside it is one quote; CRLF or a lone CR inside it is
//   read as LF and counts as a line). What follows its closing quote, up
//   to the next comma or line break, is appended as it stands (error
//   quote_junk, when the field ends). A quote that never closes is a
//   literal character and the text after it is read again as unquoted
//   (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it (every record when header is false), each padded
//   with empty strings (short_row, with fields: its field count) or cut
//   (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; a record's
//   short_row / long_row is reported when it ends, with line the 1-based
//   line its record starts on (counting every LF, CRLF and lone CR inside
//   quotes) and row its record's index in rows (null for the header).
//
// Speed: scanning is done with indexOf (C-level) rather than a
// per-character loop, and field values are slices, not built char by char.

export function run(input) {
  let text = input.text;
  const header = !!input.header;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const n = text.length;
  let i = 0;
  let line = 1;
  const records = [];
  const errors = [];
  const DELIM = /[,\n\r]/g;

  // Row index of the record currently being parsed, in `rows` terms.
  const rowOf = (recIdx) => (header ? (recIdx === 0 ? null : recIdx - 1) : recIdx);

  while (i < n) {
    // Empty line: no record. A lone CR here is dropped as stray_cr.
    let c = text.charCodeAt(i);
    if (c === 10) { i++; line++; continue; }
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { i += 2; line++; continue; }
      errors.push({ code: "stray_cr", line, row: rowOf(records.length) });
      i++;
      continue;
    }

    const recStartLine = line;
    const recIdx = records.length;
    const fields = [];

    // ---- one record ----
    for (;;) {
      // ---- one field ----
      let value;
      if (text.charCodeAt(i) === 34) {
        // Quoted field.
        const start = i;
        const chunks = [];
        let j = i + 1;
        let closed = false;
        let fieldLine = line;
        // Count line breaks inside a quoted chunk by scanning the chunk
        // itself (bounded by its length), never the rest of the text.
        const countBreaks = (s) => {
          for (let t = 0; t < s.length; t++) {
            const cc = s.charCodeAt(t);
            if (cc === 10) fieldLine++;
            else if (cc === 13) { fieldLine++; if (s.charCodeAt(t + 1) === 10) t++; }
          }
        };
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) {
            // No closing quote: the error's line is the line at the end.
            countBreaks(text.slice(j));
            break;
          }
          if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
            const seg = text.slice(j, q + 1);
            countBreaks(seg);
            chunks.push(seg.replace(/\r\n?/g, "\n"));
            j = q + 2;
            continue;
          }
          const seg = text.slice(j, q);
          countBreaks(seg);
          chunks.push(seg.replace(/\r\n?/g, "\n"));
          j = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          // Unterminated quote: the opening quote is a literal and the
          // text after it is read again as unquoted.
          errors.push({ code: "unterminated_quote", line: fieldLine, row: rowOf(recIdx) });
          i = start;
          value = parseUnquoted();
        } else {
          line = fieldLine;
          // Junk after the closing quote, up to the next comma or break.
          let junk = "";
          for (;;) {
            const e = nextDelim(j);
            junk += text.slice(j, e);
            j = e;
            if (j >= n) break;
            const cc = text.charCodeAt(j);
            if (cc === 44 || cc === 10) break;
            if (cc === 13) {
              if (text.charCodeAt(j + 1) === 10) break;
              errors.push({ code: "stray_cr", line, row: rowOf(recIdx) });
              j++;
              continue;
            }
            break;
          }
          if (junk) errors.push({ code: "quote_junk", line, row: rowOf(recIdx) });
          value = chunks.length === 1 ? chunks[0] + junk : chunks.join("") + junk;
          i = j;
        }
      } else {
        value = parseUnquoted();
      }
      fields.push(value);

      if (i < n && text.charCodeAt(i) === 44) { i++; continue; }
      break;
    }

    // ---- record terminator ----
    if (i < n) {
      if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i += 2;
      else if (text.charCodeAt(i) === 10) i++;
      // A lone CR here cannot happen: parseUnquoted drops it as stray_cr.
      line++;
    }

    // ---- width check ----
    if (records.length === 0) {
      records.push(fields);
    } else {
      const width = records[0].length;
      const row = rowOf(recIdx);
      if (fields.length < width) {
        errors.push({ code: "short_row", line: recStartLine, row, fields: fields.length });
        while (fields.length < width) fields.push("");
      } else if (fields.length > width) {
        errors.push({ code: "long_row", line: recStartLine, row, extra: fields.slice(width) });
        fields.length = width;
      }
      records.push(fields);
    }
  }

  function nextDelim(from) {
    // Index of the next ',', LF or CR at or after `from` (or n).
    // A regex exec stops at the first match; indexOf('\r') would scan
    // the whole rest of the text on every field when there is no CR.
    DELIM.lastIndex = from;
    const m = DELIM.exec(text);
    return m ? m.index : n;
  }

  function parseUnquoted() {
    // Parses an unquoted field starting at i; leaves i at the comma,
    // line break or EOF that ends it. Lone CRs are dropped as stray_cr.
    let out = "";
    for (;;) {
      const e = nextDelim(i);
      out += text.slice(i, e);
      i = e;
      if (i >= n) return out;
      const cc = text.charCodeAt(i);
      if (cc === 13) {
        if (text.charCodeAt(i + 1) === 10) return out;
        errors.push({ code: "stray_cr", line, row: rowOf(records.length) });
        i++;
        continue;
      }
      return out;
    }
  }

  const columns = header ? (records.length ? records[0] : null) : null;
  const rows = header ? records.slice(1) : records;
  return { columns, rows, errors };
}
