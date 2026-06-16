<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  exercise: {
    contractSeconds: number
    relaxSeconds: number
    repeatCount: number
  }
}>()

const emit = defineEmits<{
  (e: 'complete'): void
  (e: 'skip'): void
}>()

// 运动状态
const phase = ref<'contract' | 'relax' | 'done'>('contract')
const currentRound = ref(1)
const secondsLeft = ref(props.exercise.contractSeconds)
const isRunning = ref(true)

// 进度百分比
const progress = computed(() => {
  const totalSeconds = phase.value === 'contract'
    ? props.exercise.contractSeconds
    : props.exercise.relaxSeconds
  return ((totalSeconds - secondsLeft.value) / totalSeconds) * 100
})

// 阶段文字
const phaseText = computed(() => {
  if (phase.value === 'contract') return '收缩中...'
  if (phase.value === 'relax') return '放松中...'
  return '运动已完成！'
})

// 倒计时
let timer: number | null = null

const tick = () => {
  if (!isRunning.value) return

  secondsLeft.value--

  if (secondsLeft.value <= 0) {
    // 当前阶段结束
    if (phase.value === 'contract') {
      // 切换到放松阶段
      phase.value = 'relax'
      secondsLeft.value = props.exercise.relaxSeconds
    } else if (phase.value === 'relax') {
      // 放松阶段结束，检查是否还有下一轮
      if (currentRound.value < props.exercise.repeatCount) {
        currentRound.value++
        phase.value = 'contract'
        secondsLeft.value = props.exercise.contractSeconds
      } else {
        // 全部完成
        phase.value = 'done'
        isRunning.value = false
        if (timer) clearInterval(timer)
      }
    }
  }
}

onMounted(() => {
  timer = window.setInterval(tick, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// 手动完成
const handleComplete = () => {
  emit('complete')
}

// 跳过
const handleSkip = () => {
  emit('skip')
}
</script>

<template>
  <div class="exercise-guide">
    <el-card class="guide-content">
      <!-- 阶段标题 -->
      <h2 class="phase-title">{{ phaseText }}</h2>

      <!-- 倒计时显示（运动中） -->
      <div v-if="phase !== 'done'" class="countdown">
        <div class="seconds-display">
          <span class="seconds-number">{{ secondsLeft }}</span>
          <span class="seconds-unit">秒</span>
        </div>

        <!-- 进度条 -->
        <el-progress :percentage="progress" :stroke-width="8" />

        <!-- 进度信息 -->
        <p class="round-info">第 {{ currentRound }} / {{ exercise.repeatCount }} 次</p>
      </div>

      <!-- 完成按钮（运动结束后） -->
      <div v-if="phase === 'done'" class="done-buttons">
        <el-button type="success" size="large" @click="handleComplete">已完成</el-button>
        <el-button size="large" @click="handleSkip">跳过</el-button>
      </div>

      <!-- 提示（运动中） -->
      <p v-if="phase !== 'done'" class="hint">
        请按照节奏收缩和放松盆底肌
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.exercise-guide {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
}

.guide-content {
  padding: 8px 12px;
  text-align: center;
  width: 140px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  border-radius: 8px;
}

.phase-title {
  font-size: 12px;
  margin-bottom: 6px;
}

.countdown {
  margin-bottom: 8px;
}

.seconds-display {
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: 2px;
  margin-bottom: 8px;
}

.seconds-number {
  font-size: 22px;
  font-weight: bold;
}

.seconds-unit {
  font-size: 12px;
}

.round-info {
  font-size: 10px;
  margin-top: 6px;
}

.done-buttons {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 6px;
}

.hint {
  font-size: 9px;
  margin-top: 6px;
}
</style>