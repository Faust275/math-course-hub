/**
 * fflate-like minimal pure-JS zip reader/writer (zero dependencies, 100% offline).
 * Capable of extracting docx word/document.xml and creating zip files in the browser.
 */
var MiniZip = (function() {
  function createZip() {
    var files = {};
    return {
      file: function(name, content) {
        files[name] = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      },
      folder: function(prefix) {
        var p = prefix.replace(/\/+$/, '') + '/';
        return {
          file: function(name, content) {
            files[p + name] = typeof content === 'string' ? new TextEncoder().encode(content) : content;
          }
        };
      },
      generateAsync: async function(options) {
        // Build uncompressed ZIP (Store method 0, universally supported by all OS unzip tools)
        var entries = [];
        var offset = 0;
        var parts = [];

        var names = Object.keys(files);
        for (var i = 0; i < names.length; i++) {
          var name = names[i];
          var data = files[name];
          var nameBytes = new TextEncoder().encode(name);

          // Local file header (30 bytes)
          var lh = new Uint8Array(30 + nameBytes.length);
          var lv = new DataView(lh.buffer);
          lv.setUint32(0, 0x04034b50, true); // Local file header signature
          lv.setUint16(4, 20, true);         // Version needed to extract (2.0)
          lv.setUint16(6, 0x0800, true);     // General purpose bit flag (Bit 11: UTF-8)
          lv.setUint16(8, 0, true);          // Compression method (0 = store)
          lv.setUint16(10, 0, true);         // Last mod file time
          lv.setUint16(12, 0, true);         // Last mod file date
          
          // CRC32 calculation
          var crc = crc32(data);
          lv.setUint32(14, crc, true);       // CRC-32
          lv.setUint32(18, data.length, true); // Compressed size
          lv.setUint32(22, data.length, true); // Uncompressed size
          lv.setUint16(26, nameBytes.length, true); // File name length
          lv.setUint16(28, 0, true);         // Extra field length
          lh.set(nameBytes, 30);

          entries.push({
            nameBytes: nameBytes,
            crc: crc,
            size: data.length,
            offset: offset
          });

          parts.push(lh);
          parts.push(data);
          offset += lh.length + data.length;
        }

        var cdOffset = offset;
        var cdSize = 0;

        // Central directory headers
        for (var j = 0; j < entries.length; j++) {
          var e = entries[j];
          var cdh = new Uint8Array(46 + e.nameBytes.length);
          var cv = new DataView(cdh.buffer);
          cv.setUint32(0, 0x02014b50, true); // Central file header signature
          cv.setUint16(4, 20, true);         // Version made by
          cv.setUint16(6, 20, true);         // Version needed
          cv.setUint16(8, 0x0800, true);     // Flags (UTF-8)
          cv.setUint16(10, 0, true);         // Method 0
          cv.setUint16(12, 0, true);         // Mod time
          cv.setUint16(14, 0, true);         // Mod date
          cv.setUint32(16, e.crc, true);
          cv.setUint32(20, e.size, true);
          cv.setUint32(24, e.size, true);
          cv.setUint16(28, e.nameBytes.length, true);
          cv.setUint16(30, 0, true);         // Extra length
          cv.setUint16(32, 0, true);         // Comment length
          cv.setUint16(34, 0, true);         // Disk number start
          cv.setUint16(36, 0, true);         // Internal attributes
          cv.setUint32(38, 0, true);         // External attributes
          cv.setUint32(42, e.offset, true);  // Relative offset of local header
          cdh.set(e.nameBytes, 46);

          parts.push(cdh);
          cdSize += cdh.length;
        }

        // End of central directory record (22 bytes)
        var eocd = new Uint8Array(22);
        var ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);   // EOCD signature
        ev.setUint16(4, 0, true);            // Number of this disk
        ev.setUint16(6, 0, true);            // Disk where CD starts
        ev.setUint16(8, entries.length, true); // Total entries this disk
        ev.setUint16(10, entries.length, true); // Total entries
        ev.setUint32(12, cdSize, true);      // Size of central directory
        ev.setUint32(16, cdOffset, true);    // Offset of start of central directory
        ev.setUint16(20, 0, true);           // Comment length
        parts.push(eocd);

        return new Blob(parts, { type: 'application/zip' });
      }
    };
  }

  // Pure JS CRC32 table
  var crcTable = (function() {
    var c, t = [];
    for (var n = 0; n < 256; n++) {
      c = n;
      for (var k = 0; k < 8; k++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var crc = 0 ^ (-1);
    for (var i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  // Minimal DOCX extract (reads word/document.xml without external libraries)
  async function extractDocx(file) {
    var buf = await file.arrayBuffer();
    var bytes = new Uint8Array(buf);
    
    // Scan for word/document.xml in ZIP bytes
    // Signature PK\x03\x04
    var target = "word/document.xml";
    var dec = new TextDecoder();
    for (var i = 0; i < bytes.length - 30; i++) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
        var view = new DataView(buf, i, 30);
        var method = view.getUint16(8, true);
        var compSize = view.getUint32(18, true);
        var uncompSize = view.getUint32(22, true);
        var nameLen = view.getUint16(26, true);
        var extraLen = view.getUint16(28, true);
        var name = dec.decode(bytes.subarray(i + 30, i + 30 + nameLen));
        if (name === target) {
          var dataStart = i + 30 + nameLen + extraLen;
          var rawData = bytes.subarray(dataStart, dataStart + compSize);
          if (method === 0) {
            return dec.decode(rawData);
          } else if (method === 8) {
            // Deflate stream: use browser native DecompressionStream if available!
            if (typeof DecompressionStream !== 'undefined') {
              var ds = new DecompressionStream('deflate-raw');
              var writer = ds.writable.getWriter();
              writer.write(rawData);
              writer.close();
              var resp = new Response(ds.readable);
              return await resp.text();
            }
          }
        }
      }
    }
    throw new Error("未在 docx 中检索到 word/document.xml");
  }

  return {
    createZip: createZip,
    extractDocx: extractDocx
  };
})();
