sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // One ZIP per this many RFQs. Small enough that each request finishes well
  // under the gateway timeout and each ZIP stays a sensible size.
  var BATCH_SIZE = 100;

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

  // The RFQs service key is ObjectID.
  function objectIdOf(ctx) {
    return ctx.getProperty("ObjectID") || ctx.getProperty("ID");
  }

  function triggerDownload(url, filename) {
    // Fetch the ZIP, then save it, so we can await completion and run the
    // next batch only once this one has finished (keeps one request in flight).
    return fetch(url, { credentials: "same-origin" }).then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.blob();
    }).then(function (blob) {
      var objUrl = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    });
  }

  function downloadBatchesSequentially(aIDs) {
    var batches = [];
    for (var i = 0; i < aIDs.length; i += BATCH_SIZE) {
      batches.push(aIDs.slice(i, i + BATCH_SIZE));
    }

    var run = function (idx) {
      if (idx >= batches.length) {
        MessageBox.success("All " + batches.length + " batches downloaded (" + aIDs.length + " RFQs).");
        return;
      }
      MessageToast.show("Downloading batch " + (idx + 1) + " of " + batches.length + "…", { duration: 4000 });
      var sUrl = "/migration/download/rfqs?ids=" + encodeURIComponent(batches[idx].join(","));
      triggerDownload(sUrl, "rfq_batch_" + (idx + 1) + "_of_" + batches.length + ".zip")
        .then(function () { run(idx + 1); })
        .catch(function (e) {
          MessageBox.error("Batch " + (idx + 1) + " failed: " + e.message +
            "\nAlready-downloaded batches are saved. Re-select the remaining RFQs and try again.");
        });
    };
    run(0);
  }

  return {
    /**
     * Download the attachments of every selected RFQ, one folder per RFQ.
     * Up to BATCH_SIZE RFQs: a single ZIP. More: one ZIP per batch, downloaded
     * sequentially so large selections (thousands) don't time out.
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
        window.open("/migration/download/rfqs?ids=" + encodeURIComponent(aIDs.join(",")), "_blank");
        return;
      }

      var nBatches = Math.ceil(aIDs.length / BATCH_SIZE);
      MessageBox.confirm(
        "You selected " + aIDs.length + " RFQs. They will be downloaded as " + nBatches +
        " ZIP files (up to " + BATCH_SIZE + " RFQs each), one after another.\n\n" +
        "Keep this tab open until all " + nBatches + " downloads finish. Your browser may ask " +
        "once to allow multiple downloads — choose Allow.\n\nStart the download?",
        {
          title: "Batched download",
          onClose: function (sAction) {
            if (sAction === MessageBox.Action.OK) {
              downloadBatchesSequentially(aIDs);
            }
          }
        }
      );
    }
  };
});
