import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/tokens.css'
import './style.css'
import './styles/foundations.css'
import './styles/components.css'

createApp(App).use(router).mount('#app')
