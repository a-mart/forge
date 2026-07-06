/**
 * Shared collaboration scope loading + selector items (WP-U3, roadmap 3.7).
 *
 * `SettingsSpecialists` and `SkillsViewer` both load collab categories/channels
 * when their target is a collab backend and render a near-identical
 * global / profile / category / channel scope selector.  This module extracts
 * the two duplicated pieces:
 *
 *   - {@link useCollabScopeData} — the `isCollab`-gated categories/channels
 *     fetch (archived channels filtered out) plus the setters both surfaces use
 *     to reconcile local state after a category/channel-selection save.
 *   - {@link CollabScopeSelectItems} — the `<SelectItem>` / `<SelectGroup>`
 *     children of the scope `<Select>`.  Callers keep their own `<Select>`,
 *     `<SettingsSection>`, and surrounding layout so surface-specific chrome
 *     (labels, descriptions, share/import buttons) is unchanged.
 *
 * The two surfaces differ only in their "global" scope sentinel
 * (`'global'` for specialists, `'__global__'` for skills) and their global
 * label copy, so those are props rather than hard-coded — behavior stays
 * byte-for-byte identical to the pre-extraction inline versions.
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { CollaborationCategory, CollaborationChannel, ManagerProfile } from '@forge/protocol'
import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select'
import type { SettingsApiClient } from './settings-api-client'
import { fetchCollabCategories, fetchCollabChannels } from './specialists-api'

/** Category/channel scope prefixes shared by both settings surfaces. */
export const COLLAB_CATEGORY_PREFIX = 'category:'
export const COLLAB_CHANNEL_PREFIX = 'channel:'

export interface CollabScopeData {
  collabCategories: CollaborationCategory[]
  collabChannels: CollaborationChannel[]
  setCollabCategories: Dispatch<SetStateAction<CollaborationCategory[]>>
  setCollabChannels: Dispatch<SetStateAction<CollaborationChannel[]>>
}

/**
 * Load collab categories/channels for a collab-targeted settings surface.
 *
 * No-ops (leaves both lists empty) when `isCollab` is false.  Archived channels
 * are filtered out.  `changeKey` re-triggers the load when the surface's
 * relevant change signal ticks (specialistChangeKey / skills changeKey).  Fetch
 * failures are swallowed — the selector simply shows Global only, matching the
 * prior inline behavior.
 */
export function useCollabScopeData(
  clientOrWsUrl: SettingsApiClient | string,
  isCollab: boolean,
  changeKey: number | undefined,
): CollabScopeData {
  const [collabCategories, setCollabCategories] = useState<CollaborationCategory[]>([])
  const [collabChannels, setCollabChannels] = useState<CollaborationChannel[]>([])

  useEffect(() => {
    if (!isCollab) return
    let cancelled = false

    Promise.all([
      fetchCollabCategories(clientOrWsUrl),
      fetchCollabChannels(clientOrWsUrl),
    ])
      .then(([categories, channels]) => {
        if (!cancelled) {
          setCollabCategories(categories)
          setCollabChannels(channels.filter((ch) => !ch.archived))
        }
      })
      .catch(() => {
        // Scope selector will just show Global if fetch fails
      })

    return () => {
      cancelled = true
    }
  }, [isCollab, clientOrWsUrl, changeKey])

  return { collabCategories, collabChannels, setCollabCategories, setCollabChannels }
}

export interface CollabScopeSelectItemsProps {
  isCollab: boolean
  /** Builder profiles shown as scopes when not in collab mode. */
  profiles: ManagerProfile[]
  collabCategories: CollaborationCategory[]
  collabChannels: CollaborationChannel[]
  /** Sentinel value for the Global option (`'global'` vs `'__global__'`). */
  globalScopeValue: string
  /** Label for the Global option in collab vs non-collab mode. */
  globalCollabLabel?: string
  globalLabel?: string
}

/**
 * The `<Select>` children for the scope selector: Global, then either the
 * builder profiles (non-collab) or the collab categories/channels groups.
 * Rendered as a fragment so the caller supplies the enclosing `<Select>`.
 */
export function CollabScopeSelectItems({
  isCollab,
  profiles,
  collabCategories,
  collabChannels,
  globalScopeValue,
  globalCollabLabel = 'Global Collaboration',
  globalLabel = 'Global',
}: CollabScopeSelectItemsProps) {
  return (
    <>
      <SelectItem value={globalScopeValue}>
        {isCollab ? globalCollabLabel : globalLabel}
      </SelectItem>
      {/* Builder: show profiles */}
      {!isCollab &&
        profiles.map((profile) => (
          <SelectItem key={profile.profileId} value={profile.profileId}>
            {profile.displayName || profile.profileId}
          </SelectItem>
        ))}
      {/* Collab: show categories */}
      {isCollab && collabCategories.length > 0 && (
        <SelectGroup>
          <SelectLabel className="text-xs">Categories</SelectLabel>
          {collabCategories.map((cat) => (
            <SelectItem
              key={`category:${cat.categoryId}`}
              value={`${COLLAB_CATEGORY_PREFIX}${cat.categoryId}`}
            >
              Category: {cat.name}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {/* Collab: show channels */}
      {isCollab && collabChannels.length > 0 && (
        <SelectGroup>
          <SelectLabel className="text-xs">Channels</SelectLabel>
          {collabChannels.map((ch) => (
            <SelectItem
              key={`channel:${ch.channelId}`}
              value={`${COLLAB_CHANNEL_PREFIX}${ch.channelId}`}
            >
              #{ch.name}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
    </>
  )
}
