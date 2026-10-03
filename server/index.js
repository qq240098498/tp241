const path = require('path');
const express = require('express');
const api = require('./api');
const store = require('./store');
const snapshotLib = require('./snapshot');

const app = express();
const port = Number(Number(process.env.PORT || 5241));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', api);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || '服务端出错了',
      details: err.details || null,
    },
  });
});

// 为没有快照的历史放行单反查补建（口径只能按当前值推断，快照会明确标记 parametersAssumed）
function backfillOnBoot() {
  try {
    const data = store.load();
    const created = snapshotLib.backfillMissing(data);
    if (created.length) {
      store.save(data);
      console.log('已为 ' + created.length + ' 张历史放行单反查补建决策快照（口径按当前设置推断，已标记）');
    }
  } catch (err) {
    console.log('历史放行单快照补建跳过：' + err.message);
  }
}

app.listen(port, () => {
  backfillOnBoot();
  let info = '';
  try {
    const data = store.load();
    info = '冷库或者车厢 ' + data.rooms.length + ' 个、探头 ' + data.probes.length + ' 个、批次 ' + data.batches.length + ' 条、温度记录 ' + data.records.length + ' 条、决策快照 ' + data.snapshots.length + ' 份';
  } catch (err) {
    info = '数据文件还没准备好：' + err.message;
  }
  console.log('冷链温控与批次放行台已启动：http://localhost:' + port + '（' + info + '）');
});
