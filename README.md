# MAESTIVO OMR worker source

This repository contains the MAESTIVO-authored source for the tested private
OMR worker and its SSH bridge, along with the documented no-iText Audiveris
configuration and third-party source/notice references. It does not contain
the complete MAESTIVO application. It is published by the MAESTIVO operator;
no private keys, host-specific access configuration, or real user scores are
included. The running public website's OCR availability is reported by the
application, not by the presence of this repository.

## License scope

The MAESTIVO-authored source and generic service templates in `maestivo/` and
`installed-variants/` are offered under **GNU Affero General Public License,
version 3 only**; see [LICENSE](LICENSE). The lockfile and source indices
contain third-party metadata and do not change the licenses of third-party
software. Files under `third-party-records/` and the Audiveris configuration
in `records/` retain their respective upstream copyrights and terms; see the
linked notices and upstream sources. No license is asserted over unrelated
MAESTIVO code or other third-party software.

## Source and version evidence

- Audiveris 5.11.0 upstream source: [pinned commit
  `9e1e55cd2746037d059345881c53e6a6754bffbd`](https://github.com/Audiveris/audiveris/tree/9e1e55cd2746037d059345881c53e6a6754bffbd),
  [source archive](https://github.com/Audiveris/audiveris/archive/9e1e55cd2746037d059345881c53e6a6754bffbd.tar.gz),
  and [AGPLv3 text](third-party-records/audiveris-agpl-3.0.txt).
- [Tested no-iText configuration](records/no-itext-Audiveris.cfg): classpath
  entries for `jai-core-1.1.3.jar` and `itextpdf-5.5.13.2.jar` are absent;
  JVM options are `-Xms64m -Xmx256m`. The 2,628-file runtime inventory and
  37 links are recorded separately in [file hashes](records/no-itext-runtime-SHA256SUMS)
  and [link targets](records/no-itext-runtime-SYMLINKS). This inventory is an
  observation, not an exhaustive proof of source correspondence.
- The previously installed, privately tested worker bundle has SHA-256
  `84aab514d368812998f4e3ea0a8c33a9a161f03f42fbd2721b3e6c30e723834f`.
  Its MAESTIVO worker sources are available in the initial commit of this
  repository and were checked against revision
  `3dd5d0b62ad587e5e9e9269bbc55e13571b6c2ef`. The current source includes a
  subsequent shutdown fix, checked against revision
  `ab645ee713736758eb0e3b8dcac2a251f048c6bf`. That candidate's checkout
  worker bundle has SHA-256
  `1e43cc2358bce8f0a1c02ee3a87b717b2b89845269eb6e925985463b8c850402`;
  production installation is a separate operation and must not be inferred
  from the publication of this source. `installed-variants/4ff753cc/`
  contains the earlier preflight actually installed; the stronger version
  under `maestivo/` is distinct.
- The historical JAR and [Maven source-candidate index](third-party-records/maven-source-leads.json)
  describe the original 56-JAR no-JAI candidate, including the subsequently
  omitted iText JAR. The no-iText worker requires the other 55 JARs, pinned in
  [`sealed-app-jars.json`](maestivo/apps/api/src/sealed-app-jars.json).
  The [native source-candidate index](third-party-records/native-source-leads.json)
  records upstream candidates; it does not establish how every binary was built.
- For the Apache Directory Commons IO 2.4 wrapper, see the [official pinned
  wrapper and its build POM](https://github.com/apache/directory-studio/tree/d2db91a800cb51f48b4444afadc4d2a91da056e8/libraries/org.apache.commons.io)
  and the [Commons IO 2.4 sources](https://repo.maven.apache.org/maven2/commons-io/commons-io/2.4/commons-io-2.4-sources.jar).
  The nested Commons IO binary was hash-matched; a full wrapper rebuild was
  not established.

## Rebuild the worker

Use Node.js 22 and npm. The generated standalone lockfile pins the worker's
`@xmldom/xmldom`, `fflate`, `zod`, and `esbuild` dependencies. The four
package versions and integrity values match those in the original build's
lockfile; their MIT license texts are in `third-party-records/`.

```sh
cd maestivo
npm ci
npm run build:worker
shasum -a 256 ../dist/omr-worker.cjs
```

An independent `npm ci` build from this repository produced SHA-256
`2bba9d0bbf6d5eeefd8a7e047569e26adea30a9807cb4809f6cdfec41252d5a7`.
The current candidate worker above embeds 112 machine-specific dependency path prefixes
in esbuild-generated comments and module names. Replacing those prefixes with
`node_modules/` made its bytes exactly match the independent public build.
The original paths are not needed for execution and are not published here.
A matching hash is extra verification, not a universal license requirement. The included `worker-wire.test.mjs` was also run with Node 22 and passed 14
tests. The original
`bundle-candidate.mjs` builds other API entry points as well; this subset does
not contain the complete private API or all of that script's workspace inputs.
The standalone command builds only the worker.

## Limits and contact

This collection makes the identified source, configuration and references
available, but does not claim that every JRE, CRaC, JNI, static dependency,
build input or third-party notice has been independently matched to the final
runtime. Which components fall within corresponding-source obligations depends
on the actual distribution and legal scope. It is not legal advice or a claim
that the complete application is licensed or production-ready. Report source
and privacy questions to the MAESTIVO operator through the contact on the
[privacy page](https://maestivo-preview-2e8ba.web.app/privacy/).
