import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

// The bar cell: CPU/GPU/MEM/TEMP/NET segments, click anywhere in the row to
// open the quick-reference dropdown (QuickPanel.qml). All polling lives in
// QuickPanel — it runs continuously, not just while its dropdown is open, so
// this file only ever displays properties it reads off that loaded instance,
// never gathers data itself. Same split as the first-party Weather plugin's
// BarWidget.qml (bar cell) + Panel.qml (dropdown), scaled up to several
// segments the way Quadrant's own bar cell does.
BarWidget {
  id: root
  moduleName: "jharrison.sysmonitor"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = row
    if ("hostWidget" in target) target.hostWidget = root
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for the bar's popout coordinator (matches Weather's
  // BarWidget.qml): open/close/opened on the bar-widget root, not the
  // nested dropdown, is what Bar.findPanelWidget and the switch-between-
  // panels logic look for.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  readonly property var quick: panelLoader.item
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color hotColor: bar ? bar.urgent : Color.urgent

  visible: panelLoader.item !== null
  implicitWidth: row.implicitWidth
  implicitHeight: row.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("QuickPanel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Nerd Fonts v3 private-use glyphs, JetBrainsMono Nerd Font (installed on
  // this machine) -- confirmed present via fontTools' cmap, same icon family
  // (md-*) Quadrant's own Theme.js already uses for cpu/gpu/mem/disk/net, so
  // the two plugins' bar cells read as one visual language rather than two:
  //   cpu   md-chip              U+F061A
  //   gpu   md-expansion_card    U+F08AE
  //   mem   fa-memory            U+EFC5
  //   temp  md-thermometer       U+F050F  (Quadrant has no temp segment of
  //                                        its own to borrow this one from)
  //   net   md-lan               U+F0317
  readonly property string cpuGlyph: "󰘚"
  readonly property string gpuGlyph: "󰢮"
  readonly property string memGlyph: ""
  readonly property string tempGlyph: "󰔏"
  readonly property string netGlyph: "󰌗"

  Row {
    id: row
    spacing: Style.space(18)

    Segment { text: root.cpuGlyph + " " + (root.quick ? root.quick.cpuBarText : "…"); hot: root.quick && root.quick.cpuTotalPercent >= 90 }
    Segment { visible: root.quick && root.quick.gpuPath !== ""; text: root.gpuGlyph + " " + (root.quick ? root.quick.gpuBarText : "") }
    Segment { text: root.memGlyph + " " + (root.quick ? root.quick.memBarText : "…") }
    Segment { text: root.tempGlyph + " " + (root.quick ? root.quick.tempBarText : "…°"); hot: root.quick && root.quick.cpuTempC >= 85 }
    Segment { text: root.netGlyph + " " + (root.quick ? root.quick.netBarText : "↑…  ↓…") }
  }

  // Sibling of Row, not a child of it — Row forbids anchored children
  // outright ("Row will not function" if one is present), so the click
  // target has to live at this level, anchored to the row instead.
  MouseArea {
    anchors.fill: row
    cursorShape: Qt.PointingHandCursor
    onClicked: root.togglePanel()
  }

  // One bar segment: plain text, no per-segment click (the whole row shares
  // one MouseArea above and opens the one dropdown — there are no tabs to
  // route to, unlike Quadrant's per-segment click-through).
  component Segment: Text {
    property bool hot: false
    font.family: Style.font.family
    font.pixelSize: Style.bar.iconFont
    color: hot ? root.hotColor : root.foreground
    verticalAlignment: Text.AlignVCenter
    height: root.barSize
  }
}
