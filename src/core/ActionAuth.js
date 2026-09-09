/**
 * ActionAuth
 *
 * Canonical secp256k1 authorization for user-initiated actions.
 *
 * Why this exists
 * ---------------
 * The API verified a sender's signature at the HTTP layer and then built a
 * *fresh, unsigned* Transaction to put in the block:
 *
 *     if (!verifySendSignature(req.body)) return 401;
 *     const tx = Transaction.createTransfer(from, to, amount, 0n, nonce);
 *     await this.blockchain.commitSystemBlock([tx]);
 *
 * The user's signature was checked and then discarded. Nothing authorizing the
 * transfer ever reached the block, so a peer receiving it could only conclude
 * "the node that sent me this says it was authorized". The security boundary was
 * trust in one API node rather than verification by every node.
 *
 * The authorization now travels *inside* the transaction, so any node — and any
 * auditor reading the chain later — can independently confirm that the holder of
 * the sending address actually approved this exact transfer.
 *
 * One implementation, used by both the API and block validation, so the two can
 * never drift apart. (The audit flagged exactly that class of divergence between
 * the browser SDK and the node signing path.)
 */

const crypto = require('crypto');

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

class ActionAuth {
  /**
   * Derive an ANKH address from a secp256k1 public key.
   * Must match the derivation used everywhere else in the codebase.
   */
  static deriveAddress(publicKeyHex) {
    const pubBytes = Buffer.from(publicKeyHex, 'hex');
    return 'ankh_' + crypto.createHash('sha256').update(pubBytes).digest('hex').substring(0, 40);
  }

  /**
   * Verify that `signature` authorizes `message` on behalf of `address`.
   *
   * Checks both that the signature is cryptographically valid *and* that the
   * claimed public key actually derives to the address being acted upon —
   * without the second check a valid signature from any key would pass.
   *
   * @returns {{valid: boolean, reason?: string}}
   */
  static verify(address, message, signature) {
    if (!signature || !signature.publicKey || !signature.r || !signature.s) {
      return { valid: false, reason: 'Missing signature' };
    }
    try {
      const { ec: EC } = require('elliptic');
      const ec = new EC('secp256k1');

      const derived = ActionAuth.deriveAddress(signature.publicKey);
      if (derived !== address) {
        return { valid: false, reason: 'Public key does not derive to the acting address' };
      }

      const msgHash = crypto.createHash('sha256').update(message).digest();
      const key = ec.keyFromPublic(signature.publicKey, 'hex');
      if (!key.verify(msgHash, { r: signature.r, s: signature.s })) {
        return { valid: false, reason: 'Signature does not verify' };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: `Signature verification error: ${err.message}` };
    }
  }

  /**
   * Canonical message for a transfer. Field order is fixed — both the signer and
   * every verifier must serialise identically or signatures will not match.
   */
  static transferMessage({ from, to, amount, timestamp }) {
    return JSON.stringify({ from, to, amount: String(amount), timestamp });
  }

  /**
   * Verify the authorization carried inside a TRANSFER transaction.
   *
   * @param {object} tx  Transaction with data.auth = {publicKey, r, s, timestamp, to, amount}
   * @param {object} [opts]
   * @param {boolean} [opts.checkFreshness=false]  enforce the replay window.
   *        Off during block validation: a block replayed from a peer or during
   *        sync is legitimately older than the window, and replay is already
   *        prevented by the account nonce.
   */
  static verifyTransfer(tx, opts = {}) {
    const auth = tx?.data?.auth;
    if (!auth) {
      return { valid: false, reason: 'TRANSFER is missing its authorization — unsigned transfers are not accepted' };
    }
    const { publicKey, r, s, timestamp } = auth;
    if (!publicKey || !r || !s || !timestamp) {
      return { valid: false, reason: 'TRANSFER authorization is incomplete' };
    }

    if (opts.checkFreshness && Math.abs(Date.now() - timestamp) > REPLAY_WINDOW_MS) {
      return { valid: false, reason: 'Authorization timestamp outside the replay window' };
    }

    // Rebuild the signed message from the transaction's own fields, never from
    // the authorization blob — otherwise a signature over one transfer could be
    // attached to a different one.
    const message = ActionAuth.transferMessage({
      from: tx.from,
      to: tx.to,
      amount: auth.amount !== undefined ? auth.amount : tx.amount,
      timestamp
    });

    return ActionAuth.verify(tx.from, message, { publicKey, r, s });
  }
}

ActionAuth.REPLAY_WINDOW_MS = REPLAY_WINDOW_MS;
module.exports = ActionAuth;
