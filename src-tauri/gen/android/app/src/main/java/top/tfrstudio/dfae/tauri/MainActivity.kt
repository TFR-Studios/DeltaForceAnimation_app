package top.tfrstudio.dfae.tauri

import android.Manifest
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    applyDeviceOrientationPolicy()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    ensureLegacyStoragePermission()
  }

  /**
   * Android 10(API 29)以下:往系统相册写文件需要 WRITE_EXTERNAL_STORAGE。
   * 29 及以上是分区存储,应用往 MediaStore 插入自己的媒体项零权限 —— 那时连问都不问。
   * 清单里这条权限带 android:maxSdkVersion="28",所以新版系统上它根本不出现在权限列表里。
   *
   * 这里只在启动时问一次:导出是长任务,等用户按下「导出视频」再弹权限框会打断整个流程。
   */
  private fun ensureLegacyStoragePermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
        == PackageManager.PERMISSION_GRANTED) return
    ActivityCompat.requestPermissions(
      this,
      arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE),
      LEGACY_STORAGE_REQUEST,
    )
  }

  private companion object {
    const val LEGACY_STORAGE_REQUEST = 1001
  }

  /**
   * 平板锁定横屏;手机不锁。
   *
   * 为什么平板锁:这一端的界面是按「预览在左、编辑区在右」的并排布局设计的 ——
   * 竖屏时预览宽度不够看清 1920x1080 的画布,而手机竖屏是主姿态,必须保留。
   *
   * 为什么用 sensorLandscape 而不是 landscape:两者都不允许转到竖屏,
   * 区别只在后者连 180° 翻转也禁止 —— 平板倒过来拿时界面会上下颠倒,那更像故障。
   *
   * 判据用 smallestScreenWidthDp 而不是机型名录:折叠屏展开后与平板同宽,
   * 会自动落到同一条策略上。这正是 Android 官方 window size class 的定义方式
   * (sw600dp = 平板档),所以不要改成 Build.MODEL 之类的判断。
   */
  private fun applyDeviceOrientationPolicy() {
    if (resources.configuration.smallestScreenWidthDp >= 600) {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }
  }
}
