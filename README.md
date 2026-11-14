# Календарь игр Вестмарша

Неофициальная закладка для [vestmarch.noncensored.ru](https://vestmarch.noncensored.ru/games): над списком игр появляется календарь по дням, а игры, на которые вы записаны, подсвечены и показаны первыми.

**Установка:** <https://malan-x.github.io/vestmarch-calendar/>

## Как устроено

- `vestmarch-calendar.user.js` — сам скрипт. Работает и как userscript (Tampermonkey, Violentmonkey), и как скрипт, который подгружает закладка.
- `index.html` — страница установки. Закладка на ней короткая: она только подгружает `vestmarch-calendar.user.js` с GitHub Pages, поэтому исправления доходят до всех без переустановки.

Скрипт обращается только к сайту Вестмарша: читает список игр (`/api/backend/games/FetchGameSessions`), текущую сессию (`/api/auth/session`) и записи текущего пользователя (`FetchMyGameSignups`). Это внутренний API сайта, поэтому при его изменениях скрипт может перестать работать.
