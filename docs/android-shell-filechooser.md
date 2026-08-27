# Android 壳接管 `<input type="file">`（WebChromeClient.onShowFileChooser）

> **本仓库已落地**：`calculator-vault 1.0/android-project/src/com/calculatorvault/MainActivity.java` 已按本文方案实现（`buildSystemPickerIntent()` + `onShowFileChooser`），重建 APK 用 `bash android-project/build_apk.sh`。本文保留为原理说明与通用示例。

## 为什么需要

荣耀 / 华为（以及部分国产 ROM）的 WebView 对 `<input type="file">` 支持一般，常见问题：

- 只弹出图片选择器，看不到视频或其他类型文件（即使 `accept` 写了 `video/*`）；
- `capture` 属性行为不一致，拍照/录像入口丢失；
- 多选（`multiple`）被忽略；
- 选择器返回后 input 的 `change` 事件不触发。

解决方式：在 Android 壳的 `WebChromeClient` 里重写 `onShowFileChooser`，**绕过 WebView 默认实现，直接调系统文件选择器（ACTION_GET_CONTENT / Storage Access Framework）**，再把结果回传给网页。系统选择器对类型、多选的支持都远比 WebView 内置实现稳定。

> 前端代码无需任何修改：下面实现透明接管了页面上全部 `<input type="file">`（包括相册导入菜单里的"从相册选图片 / 选视频 / 从文件管理器选择"和聊天里的 📎 附件）。

## MainActivity.java（完整可用示例）

```java
package com.example.calcvault;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;   // WebView 回传句柄，一次只能有一个

    // 系统文件选择器启动器（ActivityResultContracts 方式，免手动管理 requestCode）
    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (filePathCallback == null) return;
                Uri[] uris = null;
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    if (result.getData().getClipData() != null) {
                        // 多选：从 ClipData 取出全部 URI
                        int count = result.getData().getClipData().getItemCount();
                        List<Uri> list = new ArrayList<>();
                        for (int i = 0; i < count; i++) {
                            list.add(result.getData().getClipData().getItemAt(i).getUri());
                        }
                        uris = list.toArray(new Uri[0]);
                    } else if (result.getData().getData() != null) {
                        uris = new Uri[]{ result.getData().getData() };
                    }
                }
                filePathCallback.onReceiveValue(uris);   // 必须回传（取消时传 null），否则下次 input 不再弹
                filePathCallback = null;
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // localStorage / IndexedDB 必需
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);       // 视频预览顺滑
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        webView.setWebViewClient(new WebViewClient());      // 页内跳转不调外部浏览器

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 上一轮未消费的回调先置空，避免 WebView 拒绝弹出新选择器
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                // 直接调系统文件选择器（SAF），不再走 WebView 内置实现
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                // 把网页 input 的 accept 翻译成 EXTRA_MIME_TYPES（系统选择器识别更准）
                String[] acceptTypes = params.getAcceptTypes();
                List<String> mimes = new ArrayList<>();
                for (String t : acceptTypes) {
                    if (t == null || t.trim().isEmpty()) continue;
                    for (String part : t.split(",")) {
                        String m = part.trim();
                        if (!m.isEmpty()) mimes.add(m);
                    }
                }
                if (!mimes.isEmpty()) {
                    String[] arr = mimes.toArray(new String[0]);
                    // 部分机型要求 mimeType 与数组一致：全部 image/* + video/* 时可直接用 image,video
                    if (arr.length == 1) {
                        intent.setType(arr[0]);
                    } else {
                        intent.setType("*/*");
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, arr);
                    }
                }
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);   // 允许多选（multiple）
                try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, "选择文件"));
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("file:///android_asset/index.html");   // 按实际打包路径调整
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
}
```

## 关键点（踩坑清单）

1. **回调必须消费**：无论用户选择还是取消，`filePathCallback.onReceiveValue(...)` 必须被调用一次（取消传 `null`）。否则 WebView 认为 chooser 仍在使用中，之后所有 `<input type="file">` 点击都无反应——这是最常见的"只能选一次"问题。
2. **上一轮回调先作废**：`onShowFileChooser` 被再次进入时，若旧回调还在，先 `onReceiveValue(null)`。
3. **多选结果在 ClipData**：`Intent.getData()` 只携带单选；多选要遍历 `getClipData()`。
4. **accept → EXTRA_MIME_TYPES**：系统选择器对 `image/*`、`video/*`、具体扩展名（`.pdf` 等）识别良好，比 WebView 默认翻译可靠。前端三个入口（图片 / 视频 / 文件管理器）会分别带着各自 accept 进来，无需特殊处理。
5. **拍照 / 录像（capture）**：如果需要保留"拍照 / 录制视频"入口，在 `onShowFileChooser` 里检测 `params.isCaptureEnabled()`，单独用 `MediaStore.ACTION_IMAGE_CAPTURE` / `ACTION_VIDEO_CAPTURE` 启动相机，结果 URI 回传同一 callback；并给相机输出建一个 `FileProvider`。前端聊天页的三个 input 中，`capture` 两个会带 capture 标记。
6. **权限**：`ACTION_GET_CONTENT` 走 SAF，**不需要**存储权限；只有自己实现相机/文件路径读取才需要。`AndroidManifest.xml` 最低配置：

```xml
<uses-permission android:name="android.permission.INTERNET" />
<application android:usesCleartextTraffic="false" ...>
```

7. **备份导出下载**：网页用 `a.download` 导出备份/文件，在 WebView 里多数不生效。若要顺手解决，可再重写 `DownloadListener`，或用 `WebChromeClient.onShowFileChooser` 同样的思路接管。简单方案：壳里加 `webView.setDownloadListener(...)` 用 `DownloadManager` 落盘。

## 与本项目前端的配合

前端已有兜底逻辑：`相册导入菜单` 提供三个入口（图片 / 视频 / 文件管理器），`accept` 分别为：

- `#album-img-input` → `image/*`
- `#album-vid-input` → `video/*`
- `#album-file-input` → `image/*,video/*,audio/*,.mp4,.mov,.avi,.mkv,.webm,.3gp`

接管后这些 accept 会被准确翻译给系统选择器；荣耀 / 华为机型上"只能选图片"的问题即消除。
