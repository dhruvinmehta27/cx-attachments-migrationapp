sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // Pull the array of selected table contexts out of whatever the Fiori
  // elements runtime hands the custom-action handler. Depending on the UI5
  // version this is an array, a {contexts:[...]} object, a single context,
  // or a UI5 Event whose source control exposes getSelectedContexts().
  function resolveContexts(args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (!a) continue;
      if (Array.isArray(a)) return a;
      if (Array.isArray(a.contexts)) return a.contexts;
      if (typeof a.getSource === "function") {           // a UI5 Event
        var oCtrl = a.getSource();
        while (oCtrl && typeof oCtrl.getSelectedContexts !== "function") {
          oCtrl = oCtrl.getParent && oCtrl.getParent();
        }
        if (oCtrl) return oCtrl.getSelectedContexts() || [];
      }
      if (typeof a.getObject === "function") return [a];  // a single context
    }
    return [];
  }

  // The Accounts service key is `ObjectID as ID`, so the selected row's
  // ObjectID GUID lives in the "ID" property (older mappings used "ObjectID").
  function objectIdOf(ctx) {
    return ctx.getProperty("ID") || ctx.getProperty("ObjectID");
  }

  return {
    /**
     * Download the attachments of every selected account as one ZIP,
     * with one folder per Account ID.
     */
    onDownloadSelected: function () {
      var aContexts = resolveContexts(arguments);
      var aIDs = aContexts.map(objectIdOf).filter(Boolean);

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
