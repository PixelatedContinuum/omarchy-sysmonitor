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

  // The native bar cluster this sits next to (Indicators, the workspace
  // numbers) spaces its own icons with `spacing: 0` on its Row — checked
  // directly in Indicators.qml, not assumed. The visible gap between two
  // of its icons comes entirely from each individual WidgetButton's own
  // 8.5 horizontalMargin (its default), one icon's right margin plus the
  // next one's left margin. So the native rhythm isn't "some spacing value
  // on the container" at all — it's "every icon carries its own margin,
  // and the container contributes nothing." segMargin reproduces that
  // exactly, applied to each Segment below, rather than one number chosen
  // by eye that happens to land close to it.
  readonly property real segMargin: Style.spaceReal(8.5)

  visible: panelLoader.item !== null
  implicitWidth: row.implicitWidth
  implicitHeight: row.implicitHeight

  // Bar.qml's own open-panel underline defaults to 55% of "the slot" for
  // any widget that doesn't say otherwise (checked directly in Bar.qml —
  // this is exactly the property name it looks for on this item). For a
  // single-icon widget that reads fine; for a five-segment row it reads as
  // an underline that mysteriously stops partway through the text. Quadrant
  // hits the same default and deliberately keeps its own mark short and
  // centered instead — a valid choice, just not the one asked for here:
  // this spans the widget's full rendered width.
  readonly property real openPanelIndicatorWidth: row.implicitWidth

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
    anchors.verticalCenter: parent.verticalCenter
    spacing: 0

    Segment { text: root.cpuGlyph + " " + (root.quick ? root.quick.cpuBarText : "…"); hot: root.quick && root.quick.cpuTotalPercent >= 90 }
    Segment { visible: root.quick && root.quick.gpuPath !== ""; text: root.gpuGlyph + " " + (root.quick ? root.quick.gpuBarText : "") }
    Segment { text: root.memGlyph + " " + (root.quick ? root.quick.memBarText : "…") }
    Segment { text: root.tempGlyph + " " + (root.quick ? root.quick.tempBarText : "…°"); hot: root.quick && root.quick.cpuTempC >= 85 }
    Segment { text: root.netGlyph + " " + (root.quick ? root.quick.netBarText : "↑…  ↓…") }
  }

  // Sibling of Row, not a child of it — Row forbids anchored children
  // outright ("Row will not function" if one is present), so the click
  // target has to live at this level. Filling `root` rather than just
  // `row` means the reserved edge margin is clickable too, not a dead
  // strip — matching how a normal button's own padding stays part of its
  // hit target.
  MouseArea {
    anchors.fill: parent
    cursorShape: Qt.PointingHandCursor
    onClicked: root.togglePanel()
  }

  // One bar segment: plain text, no per-segment click (the whole row shares
  // one MouseArea above and opens the one dropdown — there are no tabs to
  // route to, unlike Quadrant's per-segment click-through). leftPadding/
  // rightPadding — not Row.spacing — is what gives two adjacent segments
  // their gap, matching the native mechanism (see segMargin above). The
  // same padding on the first and last segment doubles as the widget's own
  // outer edge margin, so there is nothing separate to reserve for that.
  component Segment: Text {
    property bool hot: false
    leftPadding: root.segMargin
    rightPadding: root.segMargin
    font.family: Style.font.family
    font.pixelSize: Style.bar.iconFont
    color: hot ? root.hotColor : root.foreground
    verticalAlignment: Text.AlignVCenter
    height: root.barSize
  }
}
