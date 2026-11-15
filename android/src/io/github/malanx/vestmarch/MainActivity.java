package io.github.malanx.vestmarch;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

/**
 * Вестмарш+ — сайт Вестмарша в окне приложения, с подключённым скриптом «Календарь Вестмарша».
 * Вход идёт прямо на сайт Вестмарша; приложение только показывает его и при каждой загрузке страницы
 * подключает скрипт с GitHub Pages (обновления скрипта приходят без пересборки приложения).
 */
public class MainActivity extends Activity {
    private static final String HOST = "vestmarch.noncensored.ru";
    private static final String START_URL = "https://" + HOST + "/games";
    private static final String SCRIPT_URL = "https://malan-x.github.io/vestmarch-calendar/vestmarch-calendar.user.js";
    // То же, что делает закладка-загрузчик. Метка времени (шаг 10 минут) не даёт WebView держать старую версию скрипта.
    private static final String LOADER = "(function(){"
            + "if(location.hostname!=='" + HOST + "')return;"
            + "if(window.__vmcalLoaded||document.getElementById('vmcal-js'))return;"
            + "var s=document.createElement('script');s.id='vmcal-js';"
            + "s.src='" + SCRIPT_URL + "?app=1&t='+Math.floor(Date.now()/600000);"
            + "(document.head||document.documentElement).appendChild(s);"
            + "})();";
    private static final int FILE_REQUEST = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x1e, 0x1e, 0x2a));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // Android 15+ рисует приложение под строкой состояния и клавиатурой — отодвигаем сайт от краёв.
        // (Анонимные классы вместо лямбд: собираем javac против android.jar, а там нет LambdaMetafactory.)
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                    return WindowInsets.CONSUMED;
                }
            });
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // localStorage: свои игры, отметки «занят», настройки сайта
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " VestmarchPlus/1");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!request.isForMainFrame() || isVestmarch(uri)) return false;
                openOutside(uri); // ВК, Discord и прочее — во внешнем приложении или браузере
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(LOADER, null);
                CookieManager.getInstance().flush();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // «Файл…» в окне картинки — системный выбор файла / галерея
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, new OnBackInvokedCallback() {
                @Override
                public void onBackInvoked() {
                    goBack();
                }
            });
        }

        if (state != null) {
            web.restoreState(state);
        } else {
            Uri link = getIntent().getData();
            web.loadUrl(link != null && isVestmarch(link) ? link.toString() : START_URL);
        }
    }

    // Ссылка на Вестмарш, открытая из другого приложения, пока это уже запущено.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri link = intent.getData();
        if (link != null && isVestmarch(link)) web.loadUrl(link.toString());
    }

    private void goBack() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // не закрываем: при возврате сайт не будет грузиться заново
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { // Android 12 и старше
        goBack();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush(); // чтобы вход не терялся, если систему закроет приложение
    }

    private static boolean isVestmarch(Uri uri) {
        String scheme = uri.getScheme();
        return ("https".equals(scheme) || "http".equals(scheme)) && HOST.equalsIgnoreCase(uri.getHost());
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            // нечем открыть — просто остаёмся на месте
        }
    }
}
