<script setup>
import { nextTick, ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { useConfirmDialog } from '../composables/confirmDialog'

const { state, resolve } = useConfirmDialog()
const cancelButton = ref(null)

watch(() => state.open, async open => {
  if (!open) return
  await nextTick()
  cancelButton.value?.focus()
})

function close(value) {
  resolve(value)
}
</script>

<template>
  <Teleport to="body">
    <transition name="confirm-dialog">
      <div
        v-if="state.open"
        class="modal-overlay confirm-dialog-overlay"
        role="presentation"
        @keydown.esc.window="close(false)"
        @click.self="close(false)"
      >
        <div
          class="modal confirm-dialog-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-message"
        >
          <div class="confirm-dialog-head">
            <div class="confirm-dialog-icon"><Trash2 :size="17" /></div>
            <div class="confirm-dialog-copy">
              <h3 id="confirm-dialog-title">{{ state.title }}</h3>
              <p id="confirm-dialog-message">{{ state.message }}</p>
            </div>
          </div>
          <div class="modal-actions confirm-dialog-actions">
            <button ref="cancelButton" class="btn btn-outline" type="button" @click="close(false)">{{ state.cancelText }}</button>
            <button class="btn btn-danger" type="button" @click="close(true)">{{ state.confirmText }}</button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.confirm-dialog-overlay { z-index: 1200; }
.confirm-dialog-modal { width: min(420px, calc(100% - 32px)); padding: 22px; border-radius: var(--ds-radius-dialog); }
.confirm-dialog-head { display: flex; align-items: flex-start; gap: 12px; }
.confirm-dialog-icon { display: grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; margin-top: 1px; border-radius: 10px; color: var(--danger); background: var(--danger-bg); }
.confirm-dialog-copy { min-width: 0; padding-top: 1px; }
.confirm-dialog-modal h3 { margin: 0 0 4px; color: var(--text); font: var(--ds-type-section); font-size: 17px; letter-spacing: -.015em; }
.confirm-dialog-modal p { margin: 0; color: var(--text-secondary); font: var(--ds-type-body); font-size: 13px; line-height: 1.5; }
.confirm-dialog-actions { margin-top: 20px; }
.confirm-dialog-actions .btn { min-width: 72px; padding: 7px 14px; border-radius: var(--ds-radius-control); }
.confirm-dialog-actions .btn-danger { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--ds-color-danger-border); }
.confirm-dialog-actions .btn-danger:hover { color: var(--danger); background: #ffe5e0; border-color: var(--danger); }

@media (max-width: 640px) {
  .confirm-dialog-modal { width: 100%; padding: 20px 18px calc(17px + env(safe-area-inset-bottom)); border-radius: var(--ds-radius-dialog) var(--ds-radius-dialog) 0 0; }
}
</style>
