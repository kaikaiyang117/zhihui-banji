import { reactive } from 'vue'

const state = reactive({
  open: false,
  title: '确认操作',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
})

let pendingResolve = null

export function useConfirmDialog() {
  function confirm(options = {}) {
    if (pendingResolve) pendingResolve(false)
    state.title = options.title || '确认操作'
    state.message = options.message || ''
    state.confirmText = options.confirmText || '确认'
    state.cancelText = options.cancelText || '取消'
    state.open = true
    return new Promise(resolve => {
      pendingResolve = resolve
    })
  }

  function resolve(value) {
    state.open = false
    const callback = pendingResolve
    pendingResolve = null
    callback?.(value)
  }

  return { state, confirm, resolve }
}
