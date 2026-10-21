import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

// Lock the ledger for the plugin lifetime: two DSH hosts must not silently use
// independent budgets against the same state file. Crashed-owner recovery checks PID.
export function openStateStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const lockFile = `${file}.lock`
  function lock() {
    try {
      const fd = openSync(lockFile, 'wx')
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid }), 'utf8') } finally { closeSync(fd) }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(readFileSync(lockFile, 'utf8')) } catch { throw new Error('额度账本锁损坏；请确认旧 DSH 已退出后检查锁文件') }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('额度账本锁中的进程号无效')
      try { process.kill(owner.pid, 0) } catch (probe) {
        if (probe.code !== 'ESRCH') throw new Error('无法确认额度账本的持有进程是否退出')
        unlinkSync(lockFile)
        return lock()
      }
      throw new Error('另一 DSH 实例正在使用同一额度账本；请退出旧实例后重试')
    }
  }
  lock()
  let closed = false
  let state
  try { if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { unlinkSync(lockFile); throw new Error('额度账本读取失败，未清空已有统计', { cause: error }) }
  return {
    state,
    save(value) {
      if (closed) throw new Error('Quota state store closed')
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(value), 'utf8')
      renameSync(temp, file)
    },
    close() { if (!closed) { closed = true; unlinkSync(lockFile) } },
  }
}
