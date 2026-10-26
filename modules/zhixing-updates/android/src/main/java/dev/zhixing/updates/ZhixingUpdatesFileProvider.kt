package dev.zhixing.updates

import androidx.core.content.FileProvider

/** A distinct provider avoids device-specific issues with using FileProvider directly. */
class ZhixingUpdatesFileProvider : FileProvider()
