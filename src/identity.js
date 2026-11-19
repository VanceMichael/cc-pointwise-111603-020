/**
 * Vessel identity is never inferred from a name.
 *
 * A plan is considered the same vessel only when the source itself states a
 * vessel id, or a reviewer has recorded a cross-source link.  Names are kept
 * as evidence in `identity.basis` so a dispatcher can audit the decision; a
 * name alone yields `unconfirmed` and the row must be checked by hand.
 */

export const identityStatuses = Object.freeze({
  confirmed: 'confirmed',
  unconfirmed: 'unconfirmed',
});

function canonicalLink(link) {
  return {
    source: String(link.source ?? '').trim(),
    sourceWindowId: String(link.sourceWindowId ?? '').trim(),
    vesselId: String(link.vesselId ?? '').trim(),
    confirmedBy: String(link.confirmedBy ?? '').trim(),
  };
}

function lookup(links, source, sourceWindowId) {
  return links.find((link) => link.source === source && link.sourceWindowId === sourceWindowId) ?? null;
}

/**
 * @param record projected source window
 * @param links  reviewer-confirmed links ({ source, sourceWindowId, vesselId })
 * @returns {{status: 'confirmed'|'unconfirmed', vesselId: string|null, planKey: string|null, basis: object}}
 */
export function resolveIdentity(record, links = []) {
  const source = String(record.attributes?.source ?? '').trim();
  const sourceWindowId = String(record.attributes?.sourceWindowId ?? record.sourceId);
  const declared = String(record.attributes?.vesselId ?? '').trim();
  const link = lookup(links.map(canonicalLink), source, sourceWindowId);
  const name = String(record.attributes?.vesselName ?? '').trim();

  if (declared) {
    return {
      status: identityStatuses.confirmed,
      vesselId: declared,
      planKey: declared,
      basis: { type: 'source-vessel-id', source, sourceWindowId, vesselId: declared, vesselName: name },
    };
  }
  if (link) {
    return {
      status: identityStatuses.confirmed,
      vesselId: link.vesselId,
      planKey: link.vesselId,
      basis: {
        type: 'reviewed-link',
        source,
        sourceWindowId,
        vesselId: link.vesselId,
        confirmedBy: link.confirmedBy,
        vesselName: name,
      },
    };
  }
  return {
    status: identityStatuses.unconfirmed,
    vesselId: null,
    planKey: null,
    basis: { type: 'name-only', source, sourceWindowId, vesselName: name },
  };
}

/** Collect identity links from a fixture file without touching stored state. */
export function normalizeLinks(inputs) {
  if (!Array.isArray(inputs)) throw new TypeError('identity links must be an array');
  return inputs.map((input) => {
    const link = canonicalLink(input);
    if (!link.source || !link.sourceWindowId || !link.vesselId) {
      throw new Error('identity link needs source, sourceWindowId and vesselId');
    }
    return link;
  });
}
