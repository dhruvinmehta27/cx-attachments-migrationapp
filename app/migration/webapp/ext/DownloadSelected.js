sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // Pull the array of selected table contexts out of whatever the Fiori
  // elements runtime hands the custom-action handler (signature varies by
  // UI5 version: array arg, {contexts:[...]}, or a single context).
  function resolveContexts(args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (Array.isArray(a)) return a;
      if (a && Array.isArray(a.contexts)) return a.contexts;
      if (a && typeof a.getObject === "function") return [a];
    }
    return [];
  }

  return {
    /**
     * Download the attachments of every selected account as one ZIP,
     * with one folder per Account ID.
     */
    onDownloadSelected: function () {
      var aContexts = resolveContexts(arguments);
      var aIDs = aContexts
        .map(function (ctx) { return ctx.getProperty("ObjectID"); })
        .filter(Boolean);

      if (!aIDs.length) {
        MessageBox.warning("Select one or more accounts first.");
        return;
      }

      var sUrl = "/migration/download/accounts?ids=" +
        encodeURIComponent(aIDs.join(","));
      MessageToast.show("Preparing ZIP for " + aIDs.length + " account(s)…");
      // attachment disposition => browser downloads; the helper tab self-closes.
      window.open(sUrl, "_blank");
    }
  };
});
