sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Link",
  "sap/m/Text",
  "sap/m/VBox"
], function (MessageToast, MessageBox, Dialog, Button, Link, Text, VBox) {
  "use strict";

  // One ZIP per this many RFQs — small enough that each link's download
  // finishes well under the gateway timeout.
  var BATCH_SIZE = 100;

  // Pull the array of selected table contexts out of whatever the Fiori
  // elements runtime hands the custom-action handler.
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

  // The RFQs service key is ObjectID.
  function objectIdOf(ctx) {
    return ctx.getProperty("ObjectID") || ctx.getProperty("ID");
  }

  function batchUrl(ids) {
    return "/migration/download/rfqs?ids=" + encodeURIComponent(ids.join(","));
  }

  // Trigger a download in-place (no new tab), within the click gesture, so the
  // browser never blocks it as a popup and the page is not navigated away.
  function clickDownload(url) {
    var a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return {
    /**
     * Download the attachments of every selected RFQ, one folder per RFQ.
     * Up to BATCH_SIZE RFQs: a single ZIP. More: a dialog with one download
     * link per batch of BATCH_SIZE, which the user clicks (a real user gesture,
     * so the browser never blocks the download) one or two at a time.
     */
    onDownloadSelected: function () {
      var aContexts = resolveContexts(arguments);
      var aIDs = aContexts.map(objectIdOf).filter(Boolean);

      if (!aIDs.length) {
        MessageBox.warning("Select one or more RFQs first.");
        return;
      }

      if (aIDs.length <= BATCH_SIZE) {
        MessageToast.show("Preparing ZIP for " + aIDs.length + " RFQ(s)…");
        clickDownload(batchUrl(aIDs));
        return;
      }

      // Build one link per batch.
      var aBatches = [];
      for (var i = 0; i < aIDs.length; i += BATCH_SIZE) {
        aBatches.push(aIDs.slice(i, i + BATCH_SIZE));
      }

      var oBox = new VBox({ renderType: "Bare" });
      oBox.addItem(new Text({
        text: aIDs.length + " RFQs selected. Click each link below to download that batch " +
          "(one ZIP of up to " + BATCH_SIZE + " RFQs, each foldered per RFQ). " +
          "Download one or two at a time and let each finish before starting more.",
        wrapping: true
      }).addStyleClass("sapUiSmallMarginBottom"));

      aBatches.forEach(function (aBatch, idx) {
        var from = idx * BATCH_SIZE + 1;
        var to = idx * BATCH_SIZE + aBatch.length;
        var sUrl = batchUrl(aBatch);
        oBox.addItem(new Link({
          text: "Download batch " + (idx + 1) + " of " + aBatches.length +
            "  (RFQs " + from + "–" + to + ")",
          wrapping: true,
          press: function () { clickDownload(sUrl); }
        }).addStyleClass("sapUiTinyMarginBottom"));
      });

      var oDialog = new Dialog({
        title: "Download " + aIDs.length + " RFQs in " + aBatches.length + " batches",
        contentWidth: "30rem",
        verticalScrolling: true,
        content: [oBox],
        endButton: new Button({
          text: "Close",
          press: function () { oDialog.close(); }
        }),
        afterClose: function () { oDialog.destroy(); }
      });
      oDialog.addStyleClass("sapUiContentPadding");
      oDialog.open();
    }
  };
});
