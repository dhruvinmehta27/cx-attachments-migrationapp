const cds = require('@sap/cds');

/**
 * Pushes attachment content to a configurable generic REST/OData endpoint.
 *
 * Two delivery modes are supported transparently:
 *  1. Absolute URL  - if `targetEndpoint` starts with http(s):// the content
 *     is POSTed directly to that URL (using the platform `fetch`).
 *  2. Destination path - otherwise `targetEndpoint` is treated as a resource
 *     path relative to the remote service configured under
 *     `cds.requires.TARGET_ENDPOINT` (base URL + auth resolved from a
 *     destination), and sent through the CAP remote service.
 */
class TargetClient {
  async _service() {
    if (this._srv === undefined) {
      try {
        this._srv = await cds.connect.to('TARGET_ENDPOINT');
      } catch (e) {
        // No destination bound (e.g. local dev) - absolute URLs still work.
        this._srv = null;
      }
    }
    return this._srv;
  }

  /**
   * Send one attachment to the target.
   * @returns {Promise<{ref: string}>} a reference returned by the target (best effort)
   */
  async send({ targetEndpoint, fileName, mimeType, content, metadata }) {
    const payload = {
      fileName,
      mimeType,
      // base64 keeps the transport JSON-safe for arbitrary binary content.
      contentBase64: Buffer.from(content).toString('base64'),
      ...metadata
    };

    if (/^https?:\/\//i.test(targetEndpoint)) {
      const res = await fetch(targetEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error(`Target responded ${res.status} ${res.statusText}`);
      }
      const ref = res.headers.get('location') || await this._refFromBody(res);
      return { ref: ref || targetEndpoint };
    }

    const srv = await this._service();
    if (!srv) {
      throw new Error(
        `Target endpoint "${targetEndpoint}" is not an absolute URL and no TARGET_ENDPOINT destination is configured.`
      );
    }
    const result = await srv.send({
      method: 'POST',
      path: targetEndpoint,
      data: payload,
      headers: { 'content-type': 'application/json' }
    });
    return { ref: result?.id || result?.ID || result?.Location || targetEndpoint };
  }

  async _refFromBody(res) {
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const body = await res.json();
        return body?.id || body?.ID || body?.ref || null;
      }
    } catch { /* ignore - reference is best effort */ }
    return null;
  }
}

module.exports = new TargetClient();
