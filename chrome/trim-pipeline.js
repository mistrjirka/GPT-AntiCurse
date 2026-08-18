/* Explicit composition point for production conversation trimming. */
(function (global) {
  "use strict";

  const core = global.CGTrimCore;
  const logical = global.CGTrimLogical;
  if (!core || !logical || typeof logical.trimConversation !== "function") return;

  const api = Object.freeze({
    ...core,
    trimConversation: logical.trimConversation,
    logicalWindowInfo: logical.logicalWindowInfo,
    logicalUnitCount: logical.logicalUnitCount
  });

  global.CGTrim = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
