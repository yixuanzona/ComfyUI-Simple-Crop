# Simple Crop — ComfyUI Custom Node 規格

## 目標

一個單一、直覺、視覺化的裁切節點：在節點上直接用滑鼠拖曳一個裁切框，
輸入/輸出都是 `IMAGE`（`[B,H,W,C]` tensor）。因為 ComfyUI 的 IMAGE 本來就是
一個 batch，這個節點同時支援單張圖片與影片幀序列（例如接在
VHS `Load Video` 之後、再接到 VHS `Video Combine`），不需要另外分兩個節點。

遵循 `jtydhr88/comfyui-custom-node-skills` 的 V3 API 慣例
（`io.ComfyNode` / `io.Schema` / `io.NodeOutput`），並以本機
`ComfyUI 0.32.0`（`comfy_api/latest`）原始碼核對過實際簽章。

## 套件結構

```
D:\DevTools\simple\
  __init__.py          # V3 擴充註冊 (comfy_entrypoint) + WEB_DIRECTORY
  nodes.py              # SimpleCrop 節點本體
  js/
    simple_image_crop.js  # 前端：畫布拖曳裁切框 UI
  pyproject.toml
  README.md
  SPEC.md
```

## 後端節點：`SimpleCrop`

- `node_id`: `SimpleCrop`（本機 custom_nodes 內掃過，無 id 衝突）
- `display_name`: `Simple Crop`
- `category`: `image/transform`
- `is_output_node = True`：即使還沒接下游節點，也會執行並回傳預覽圖，
  方便單獨調整裁切框時立刻用「Queue」確認結果。

### Inputs

| id | 型別 | 說明 |
|---|---|---|
| `image` | `IMAGE` | 來源圖片/影格序列 |
| `x` | `INT`，預設 0 | 裁切框左上角 X（像素） |
| `y` | `INT`，預設 0 | 裁切框左上角 Y（像素） |
| `width` | `INT`，預設 512 | 裁切寬度（像素） |
| `height` | `INT`，預設 512 | 裁切高度（像素） |

座標系統採**像素**（不是 0-1 百分比）——與 ComfyUI 內建 `BOUNDING_BOX`
widget 的慣例一致，且輸出時對應原圖解析度最直覺。

### Output

| id | 型別 | 說明 |
|---|---|---|
| `IMAGE` | `IMAGE` | 裁切後的批次，`B` 維度不變，`H=height, W=width` |

### 執行邏輯（`execute`）

1. 讀取 `image.shape -> b, h, w, c`
2. 把 `x, y, width, height` clamp 到合法範圍內（裁切框不會超出原圖邊界，
   即使前端因為連錯圖或解析度改變而送出越界數值，也不會噴錯）
3. `cropped = image[:, y0:y1, x0:x1, :]`
4. 回傳 `io.NodeOutput(cropped, ui=ui.PreviewImage(cropped, cls=cls))`
   —— 同時輸出資料，也順便在節點上顯示裁切後的縮圖，這樣「執行完馬上能
   肉眼確認裁切對不對」，不用額外接 Preview/Save 節點。

## 前端 UI（`js/simple_image_crop.js`）

### 互動模型（对齐使用者選的「畫布上直接拖拉裁切框」）

1. 節點建立時，在四個數字 widget（x/y/width/height）**上方**插入一個
   DOM widget：一塊 `<canvas>`，畫出來源圖片縮圖 + 半透明遮罩 + 裁切框
   （框線 + 四角控制點）。
2. 圖片預覽來源，依優先序：
   - 上游節點如果是 VHS 系列的影片載入節點（有 `videopreview` 這個 DOM
     widget），直接拿它自己正在播放/顯示的 `<video>`（或動態圖用的
     `<img>`）元素當畫布背景，畫的是「目前那一幀」，不用先執行整個
     工作流程就能設定裁切框——這個管道是後來為了修 VHS `Load Video`
     接上去看不到預覽的問題另外補的，因為這類節點的縮圖不是走
     `app.nodeOutputs` 或 `.imgs`，而是自己管理一顆 `<video>`。
   - 否則，如果上游節點有 `app.nodeOutputs[id].images`（例如
     `LoadImage` 選完檔案、或任何先前執行過的節點）→ 用那張圖當背景。
     舊版前端把縮圖快取在 `.imgs`，也當備援管道。
   - 上面都找不到，但本節點自己先前執行過 → 退而求其次顯示「上次輸出
     （已裁切）」，並在狀態列註明，避免混淆。
   - 都沒有 → 顯示「尚無預覽，請連接圖片/影片節點或先執行一次」的提示
     文字，裁切框仍可用數字 widget 手動輸入。
   - 如果上游是播放中的影片，畫面會跟著影片的 `timeupdate` 事件更新
     （拖曳裁切框時暫停更新，避免打架）。
3. 滑鼠操作：
   - 拖曳裁切框內部 = 平移
   - 拖曳四角 = 等比縮放該角
   - 拖曳四邊中點 = 只調整該邊
   - 放開滑鼠時把畫布座標換算回原圖像素座標、四捨五入成整數、clamp 在
     `[0, naturalWidth] x [0, naturalHeight]`，寫回 `x/y/width/height`
     四個 widget 的 value（觸發正常序列化，工作流程存檔會記住裁切框）。
4. 數字 widget 也保留原本可直接輸入/拖曳的功能，兩邊互相同步（改數字
   畫布上的框跟著動；拖畫布數字跟著變），滿足「精確輸入」與「視覺化」
   兩種使用情境。
5. 右上角一顆「Refresh preview」按鈕：手動重新抓上游縮圖（涵蓋自動偵測
   沒抓到變化的邊角案例，例如上游節點在群組裡、或還沒真的執行過）。
6. 第一次成功抓到一張新圖、且目前裁切框仍是預設值 `(0,0,512,512)` 時，
   自動把裁切框設成「整張圖」，避免使用者面對一個跟原圖比例對不上的
   小方框。之後只要使用者動過裁切框，就不再自動覆蓋。

### `crop_info` 跨節點同步

`crop_info` 傳的是**相對比例（0-1）**，不是像素值。因為實際使用時兩邊來源
解析度常常不同（例如 960x540 的影片，搭配另外算圖產生的 1024x1024 首幀），
直接複製像素數字會讓兩邊框到畫面中不同的區域——數字看起來一樣，實際區域
卻對不上。改成比例後，兩邊框住的永遠是「畫面裡同一塊相對區域」。

接收端的 x/y/width/height 會變成唯讀，並即時鏡射上游那顆節點的框
（換算成自己的解析度）。拔線後恢復可編輯，並保留拔線當下的數值。

### 解析度來源的優先序

畫布上的裁切框座標，必須以「後端實際會收到的張量尺寸」為準。這兩者可能
不一致：解碼器有時會給出編碼對齊後的畫格（例如 960x540 的影片實際吐出
960x544），而瀏覽器只會顯示裁掉之後的 960x540。

因此節點執行時會把真實尺寸放進 UI payload（`simple_crop_source_size`），
前端跑過一次之後就改用這個真實尺寸當座標基準，讓框選範圍與實際輸出一致。
在還沒執行過之前，退而使用影片/圖片自己回報的顯示尺寸（誤差通常只有幾個
像素）。回報值與目前來源尺寸差距過大時（>5%）視為過期，不採用。

### 已知取捨（保持「單純」而刻意不做的事）

- 不做長寬比鎖定 / 旋轉 / 格線貼齊（使用者已確認先不用，之後有需要再加）。
- 不做百分比座標模式。
- 不支援同一節點裁多個框（一個節點 = 一個裁切框，要裁多個就放多個節點）。

## 驗證方式

1. 安裝到本機 `ComfyUI_windows_portable\ComfyUI\custom_nodes\`（用 symlink
   連回 `D:\DevTools\simple`，改原始碼馬上生效不用重複複製）。
2. 啟動 ComfyUI，在節點搜尋打「Simple Crop」確認節點載入成功、
   沒有 Python import 錯誤。
3. 建一個測試工作流程：`LoadImage -> Simple Crop -> SaveImage`，
   拖裁切框、Queue 一次，比對 `SaveImage` 存出來的圖片尺寸/內容是否等於
   框選區域。
4. 影片序列驗證：`VHS Load Video -> Simple Crop -> VHS Video Combine`，
   確認每一幀都被裁到同一個框、輸出影片解析度正確。
