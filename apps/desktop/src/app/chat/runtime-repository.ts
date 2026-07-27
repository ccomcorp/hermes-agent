import { fromThreadMessageLike, getAutoStatus } from '@assistant-ui/core/internal'
import type { ExportedMessageRepository, ThreadMessage } from '@assistant-ui/react'
import { useMemo, useRef } from 'react'

import type { ChatMessage } from '@/lib/chat-messages'
import { coalesceToolOnlyAssistants, createToolMergeCache, toRuntimeMessage } from '@/lib/chat-runtime'

// The exact fallback status ExportedMessageRepository.fromBranchableArray uses.
// Normalization happens HERE, once per message, so the cached record below is
// already the final ThreadMessage the runtime consumes.
const FALLBACK_STATUS = getAutoStatus(false, false, false, false, undefined)

/**
 * ChatMessage[] -> assistant-ui message repository, with a WeakMap identity
 * cache so unchanged messages convert once (and a tool-merge cache that folds
 * tool-only assistant turns into their neighbour). Shared by the main chat's
 * runtime boundary and session tiles — one transcript pipeline, N surfaces.
 *
 * The cache stores NORMALIZED messages. `fromBranchableArray` maps the whole
 * array through `fromThreadMessageLike` on every call, so building the export
 * with it threw away the cache's reference identity once per streamed delta —
 * re-normalizing the entire settled transcript ~30x/s. Normalizing inside the
 * cache miss keeps identity stable for settled turns, which is what lets the
 * runtime reconcile detect that only the tail moved.
 */
export function useRuntimeMessageRepository(messages: ChatMessage[]): ExportedMessageRepository {
  const cacheRef = useRef(new WeakMap<ChatMessage, ThreadMessage>())
  const toolMergeCacheRef = useRef(createToolMergeCache())

  return useMemo(() => {
    const items: { message: ThreadMessage; parentId: string | null }[] = []
    const branchParentByGroup = new Map<string, string | null>()
    const seenIds = new Set<string>()
    let visibleParentId: string | null = null
    let headId: string | null = null

    for (const message of coalesceToolOnlyAssistants(messages, toolMergeCacheRef.current)) {
      // Defensive: the upstream assistant-ui MessageRepository validates that
      // no ancestor of a new parent has the same id as the child being linked.
      // If the transcript carries a duplicate id (reconciliation edge case,
      // compressed rotation, or an inflight projection that collides), the
      // runtime crashes with "MessageRepository(performOp/link): A message
      // with the same id already exists". Suppress the duplicate here so the
      // runtime sees a canonical single copy.
      if (seenIds.has(message.id)) {
        continue
      }

      seenIds.add(message.id)
      let parentId = visibleParentId

      if (message.role === 'assistant' && message.branchGroupId) {
        if (!branchParentByGroup.has(message.branchGroupId)) {
          branchParentByGroup.set(message.branchGroupId, visibleParentId)
        }

        parentId = branchParentByGroup.get(message.branchGroupId) ?? null
      }

      const cachedMessage = cacheRef.current.get(message)

      const runtimeMessage =
        cachedMessage ?? fromThreadMessageLike(toRuntimeMessage(message), message.id, FALLBACK_STATUS)

      if (!cachedMessage) {
        cacheRef.current.set(message, runtimeMessage)
      }

      items.push({ message: runtimeMessage, parentId })

      if (!message.hidden) {
        visibleParentId = message.id
        headId = message.id
      }
    }

    return { headId, messages: items }
  }, [messages])
}
