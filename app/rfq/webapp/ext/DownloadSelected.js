sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // Pull the array of selected table contexts out of whatever the Fiori
  // elements runtime hands the custom-action handler (array / {contexts} /
  // single context / a UI5 Event with getSelectedContexts()).
  function resolveContexts(args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (!a) continue;
      if (Array.isArray(a)) return a;
      if (Array.isArray(a.contexts)) return a.contexts;
      if (typeof a.getSource === "function") {
        var oCtrl = a.getSource();
        while (oCtrl && typeof oCtrl.getSelectedContexts !== "function") {
          oCtrl = oCtrl.getParent && oCtrl.getParent();
        }
        if (oCtrl) return oCtrl.getSelectedContexts() || [];
      }
      if (typeof a.getObject === "function") return [a];
    }
    return [];
  }

  // The RFQs service key is `ObjectID as ID`, so the selected row's ObjectID
  // GUID lives in the "ID" property.
  function objectIdOf(ctx) {
    return ctx.getProperty("ID") || ctx.getProperty("ObjectID");
  }

  return {
    /**
     * Download the attachments of every selected RFQ as one ZIP,
     * with one folder per RFQ ID.
     */
    onDownloadSelected: function () {
      var aContexts = resolveContexts(arguments);
      var aIDs = aContexts.map(objectIdOf).filter(Boolean);

      if (!aIDs.length) {
        MessageBox.warning("Select one or more RFQs first.");
        return;
      }

      var sUrl = "/migration/download/rfqs?ids=" +
        encodeURIComponent(aIDs.join(","));
      MessageToast.show("Preparing ZIP for " + aIDs.length + " RFQ(s)…");
      window.open(sUrl, "_blank");
    }
  };
});
