/* wb-hl.js —— 划词批注引擎（讲义 / 作业 / 教材三页共用）
   页面只需提供：window.LID（存储键）、#wb-hl-popover 等 DOM、
   可选 showToast()/updateNotesDrawer() 两个全局钩子。 */
(function () {
  'use strict';

  /* 页面钩子：页面自己的同名全局函数优先，缺了就静默降级 */
  function showToast(m) { if (typeof window.showToast === 'function') window.showToast(m); }
  function updateNotesDrawer() { if (typeof window.updateNotesDrawer === 'function') window.updateNotesDrawer(); }
  function hlId() { return window.LID || document.body.getAttribute('data-lid') || location.pathname; }

  /* ---------- 2. 多色荧光笔与划线批注系统 (Highlighter & Notes) ---------- */
  var hlPopover = document.getElementById('wb-hl-popover');
  var noteModal = document.getElementById('wb-note-modal');
  var noteQuote = document.getElementById('wb-note-quote');
  var noteInput = document.getElementById('wb-note-input');
  var noteClose = document.getElementById('wb-note-close');
  var noteSaveBtn = document.getElementById('wb-note-save-btn');
  var noteDelBtn = document.getElementById('wb-note-del-btn');
  var btnDelInPop = document.getElementById('wb-hl-btn-del');
  var btnAddNote = document.getElementById('wb-hl-add-note');

  var currentSelectionRange = null;
  var currentActiveHlId = null;

  // 获取本节所有存储的批注
  function getStoredHighlights() {
    try {
      return JSON.parse((window.WB_STORAGE||localStorage).getItem('wb_hl_' + hlId()) || '[]');
    } catch(e) { return []; }
  }
  function saveStoredHighlights(list) {
    (window.WB_STORAGE||localStorage).setItem('wb_hl_' + hlId(), JSON.stringify(list));
    updateNotesDrawer();
  }

  // 划词选区监听
  function handleTextSelect(e) {
    if (noteModal && noteModal.classList.contains('wb-open')) return;
    if (e && e.target && e.target.closest && (e.target.closest('#wb-hl-popover') || e.target.closest('#wb-note-modal') || e.target.closest('.wb-bar') || e.target.closest('.wb-toc-drawer'))) return;

    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      if (hlPopover && !currentActiveHlId) hlPopover.style.display = 'none';
      return;
    }

    var text = sel.toString().trim();
    if (text.length === 0 || text.length > 500) {
      if (hlPopover) hlPopover.style.display = 'none';
      return;
    }

    var range = sel.getRangeAt(0);
    // 忽略导航栏和目录内的选区
    var common = range.commonAncestorContainer;
    var el = common.nodeType === 1 ? common : common.parentElement;
    if (el && (el.closest('.wb-bar') || el.closest('#TOC') || el.closest('.wb-toc-drawer') || el.closest('.wb-math-bar'))) {
      if (hlPopover) hlPopover.style.display = 'none';
      return;
    }

    currentSelectionRange = range;
    currentActiveHlId = null;
    if (btnDelInPop) btnDelInPop.style.display = 'none';

    if (window.innerWidth <= 768) {
      if (hlPopover) {
        hlPopover.classList.add('wb-hl-mobile');
        hlPopover.style.top = 'auto';
        hlPopover.style.bottom = '64px';
        hlPopover.style.left = '50%';
        hlPopover.style.transform = 'translateX(-50%)';
        hlPopover.style.display = 'flex';
      }
    } else {
      var rect = range.getBoundingClientRect();
      var top = window.pageYOffset + rect.top - 46;
      var left = Math.max(10, Math.min(window.innerWidth - 220, window.pageXOffset + rect.left + (rect.width / 2) - 100));
      if (hlPopover) {
        hlPopover.classList.remove('wb-hl-mobile');
        hlPopover.style.top = top + 'px';
        hlPopover.style.bottom = 'auto';
        hlPopover.style.left = left + 'px';
        hlPopover.style.transform = 'none';
        hlPopover.style.display = 'flex';
      }
    }
  }

  var selDebounceTimer = null;
  document.addEventListener('selectionchange', function() {
    clearTimeout(selDebounceTimer);
    selDebounceTimer = setTimeout(function() {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        handleTextSelect();
      } else if (hlPopover && !currentActiveHlId) {
        hlPopover.style.display = 'none';
      }
    }, 180);
  });
  document.addEventListener('mouseup', handleTextSelect);
  document.addEventListener('touchend', function(e) {
    setTimeout(function() { handleTextSelect(e); }, 80);
  });

  // 划定高亮并包裹 DOM
  function wrapRangeWithHl(range, hlId, color, note) {
    var startNode = range.startContainer;
    var endNode = range.endContainer;

    if (startNode === endNode && startNode.nodeType === Node.TEXT_NODE) {
      var val = startNode.nodeValue;
      var s = range.startOffset, e = range.endOffset;
      var before = val.substring(0, s), mid = val.substring(s, e), after = val.substring(e);

      var mark = document.createElement('mark');
      mark.className = 'wb-user-hl wb-user-hl-' + color + (note ? ' wb-user-hl-has-note' : '');
      mark.setAttribute('data-hl-id', hlId);
      mark.setAttribute('data-color', color);
      if (note) mark.setAttribute('data-note', note);
      mark.textContent = mid;
      mark.addEventListener('click', onHighlightClick);

      var parent = startNode.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), startNode);
      parent.insertBefore(mark, startNode);
      if (after) parent.insertBefore(document.createTextNode(after), startNode);
      parent.removeChild(startNode);
      return;
    }

    var walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(n) {
          if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
          if (!n.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var textNodes = [];
    var cur;
    while (cur = walker.nextNode()) textNodes.push(cur);

    textNodes.forEach(function(node) {
      var s = (node === range.startContainer) ? range.startOffset : 0;
      var e = (node === range.endContainer) ? range.endOffset : node.nodeValue.length;
      if (s >= e) return;

      var val = node.nodeValue;
      var before = val.substring(0, s), mid = val.substring(s, e), after = val.substring(e);

      var mark = document.createElement('mark');
      mark.className = 'wb-user-hl wb-user-hl-' + color + (note ? ' wb-user-hl-has-note' : '');
      mark.setAttribute('data-hl-id', hlId);
      mark.setAttribute('data-color', color);
      if (note) mark.setAttribute('data-note', note);
      mark.textContent = mid;
      mark.addEventListener('click', onHighlightClick);

      var parent = node.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(mark, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    });
  }

  // 点击已有高亮：弹出操作选项
  function onHighlightClick(e) {
    e.stopPropagation();
    var mark = e.currentTarget;
    var hlId = mark.getAttribute('data-hl-id');
    if (!hlId) return;

    var list = getStoredHighlights();
    var item = list.find(function(x){ return x.id === hlId; });
    if (!item) return;

    currentActiveHlId = hlId;
    currentSelectionRange = null;

    var rect = mark.getBoundingClientRect();
    var top = window.pageYOffset + rect.top - 46;
    var left = Math.max(10, Math.min(window.innerWidth - 220, window.pageXOffset + rect.left + (rect.width / 2) - 100));

    if (btnDelInPop) btnDelInPop.style.display = 'inline-block';
    if (hlPopover) {
      hlPopover.style.top = top + 'px';
      hlPopover.style.left = left + 'px';
      hlPopover.style.display = 'flex';
    }
  }

  // 创建或更新高亮
  function applyColorHighlight(color) {
    if (currentActiveHlId) {
      // 切换已有高亮颜色
      var list = getStoredHighlights();
      var item = list.find(function(x){ return x.id === currentActiveHlId; });
      if (item) {
        item.color = color;
        saveStoredHighlights(list);
        document.querySelectorAll('[data-hl-id="' + currentActiveHlId + '"]').forEach(function(m) {
          m.className = 'wb-user-hl wb-user-hl-' + color + (item.note ? ' wb-user-hl-has-note' : '');
          m.setAttribute('data-color', color);
        });
        showToast('✓ 已更新标注颜色');
      }
      if (hlPopover) hlPopover.style.display = 'none';
      currentActiveHlId = null;
      return;
    }

    if (!currentSelectionRange) return;
    var text = currentSelectionRange.toString().trim();
    if (!text) return;

    var hlId = 'hl_' + Date.now() + '_' + Math.floor(Math.random()*1000);
    wrapRangeWithHl(currentSelectionRange, hlId, color, '');

    var list = getStoredHighlights();
    list.push({
      id: hlId,
      color: color,
      text: text,
      note: '',
      time: Date.now()
    });
    saveStoredHighlights(list);

    if (window.getSelection) window.getSelection().removeAllRanges();
    if (hlPopover) hlPopover.style.display = 'none';
    currentSelectionRange = null;
    showToast(color === 'underline' ? '✓ 已添加下划线' : '✓ 已添加荧光高亮');
  }

  // 绑定颜色小圆点及下划线点击
  document.querySelectorAll('.wb-hl-color-dot, .wb-hl-btn[data-color]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var color = this.getAttribute('data-color');
      applyColorHighlight(color);
    });
  });

  // 删除当前选中的高亮
  function removeHighlightById(hlId) {
    if (!hlId) return;
    var list = getStoredHighlights().filter(function(x){ return x.id !== hlId; });
    saveStoredHighlights(list);

    document.querySelectorAll('[data-hl-id="' + hlId + '"]').forEach(function(m) {
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    });
    if (hlPopover) hlPopover.style.display = 'none';
    if (noteModal) noteModal.classList.remove('wb-open');
    currentActiveHlId = null;
    showToast('✓ 已移除该处标注');
  }

  if (btnDelInPop) {
    btnDelInPop.addEventListener('click', function(e) {
      e.stopPropagation();
      removeHighlightById(currentActiveHlId);
    });
  }
  if (noteDelBtn) {
    noteDelBtn.addEventListener('click', function() {
      removeHighlightById(currentActiveHlId);
    });
  }

  // 添加/编辑便签模态浮层
  if (btnAddNote) {
    btnAddNote.addEventListener('click', function(e) {
      e.stopPropagation();
      var quoteText = '';
      var noteVal = '';

      if (currentActiveHlId) {
        var list = getStoredHighlights();
        var it = list.find(function(x){ return x.id === currentActiveHlId; });
        if (it) {
          quoteText = it.text;
          noteVal = it.note || '';
        }
      } else if (currentSelectionRange) {
        quoteText = currentSelectionRange.toString().trim();
        // 先建立默认黄色高亮
        var hlId = 'hl_' + Date.now() + '_' + Math.floor(Math.random()*1000);
        wrapRangeWithHl(currentSelectionRange, hlId, 'yellow', '');
        var list = getStoredHighlights();
        list.push({
          id: hlId,
          color: 'yellow',
          text: quoteText,
          note: '',
          time: Date.now()
        });
        saveStoredHighlights(list);
        currentActiveHlId = hlId;
      }

      if (noteQuote) noteQuote.textContent = '“' + quoteText + '”';
      if (noteInput) { noteInput.value = noteVal; setTimeout(function(){ noteInput.focus(); }, 150); }
      if (hlPopover) hlPopover.style.display = 'none';
      if (noteModal) noteModal.classList.add('wb-open');
    });
  }

  if (noteClose) {
    noteClose.addEventListener('click', function() {
      noteModal.classList.remove('wb-open');
    });
  }
  if (noteSaveBtn) {
    noteSaveBtn.addEventListener('click', function() {
      if (!currentActiveHlId) return;
      var newNote = (noteInput ? noteInput.value : '').trim();
      var list = getStoredHighlights();
      var it = list.find(function(x){ return x.id === currentActiveHlId; });
      if (it) {
        it.note = newNote;
        saveStoredHighlights(list);

        document.querySelectorAll('[data-hl-id="' + currentActiveHlId + '"]').forEach(function(m) {
          if (newNote) {
            m.classList.add('wb-user-hl-has-note');
            m.setAttribute('data-note', newNote);
          } else {
            m.classList.remove('wb-user-hl-has-note');
            m.removeAttribute('data-note');
          }
        });
        showToast(newNote ? '✓ 已保存批注便签' : '✓ 已清空便签');
      }
      noteModal.classList.remove('wb-open');
      currentActiveHlId = null;
    });
  }

  // 点击空白关闭浮层
  document.addEventListener('click', function(e) {
    if (hlPopover && !e.target.closest('#wb-hl-popover') && !e.target.closest('.wb-user-hl')) {
      hlPopover.style.display = 'none';
      currentActiveHlId = null;
    }
    if (noteModal && e.target === noteModal) {
      noteModal.classList.remove('wb-open');
    }
  });

  // 页面初次加载时恢复所有历史高亮
  function restoreSavedHighlights() {
    var list = getStoredHighlights();
    if (!list.length) return;

    list.forEach(function(item) {
      var low = item.text.toLowerCase();
      var walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            var el = node.parentElement;
            if (!el || el.closest('.wb-bar') || el.closest('#TOC') || el.closest('.wb-toc-drawer')) return NodeFilter.FILTER_REJECT;
            if (node.nodeValue.toLowerCase().indexOf(low) >= 0) return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      var matchedNode = walker.nextNode();
      if (matchedNode) {
        var idx = matchedNode.nodeValue.toLowerCase().indexOf(low);
        var range = document.createRange();
        range.setStart(matchedNode, idx);
        range.setEnd(matchedNode, idx + item.text.length);
        wrapRangeWithHl(range, item.id, item.color, item.note);
      }
    });
    updateNotesDrawer();
  }
  setTimeout(restoreSavedHighlights, 100);

  window.WB_HL = {
    getList: getStoredHighlights,
    saveList: saveStoredHighlights,
    remove: removeHighlightById,
    restore: restoreSavedHighlights
  };
})();
