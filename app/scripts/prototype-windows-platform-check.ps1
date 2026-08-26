# PROTOTYPE：验证 OpenSpec 任务 1.1 的 Windows API 基本假设，不修改系统剪贴板。
$ErrorActionPreference = "Stop"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class VistashWindowsPlatformSpike
{
    private const uint GMEM_MOVEABLE = 0x0002;
    private const uint GMEM_ZEROINIT = 0x0040;

    [StructLayout(LayoutKind.Sequential)]
    private struct DropFiles
    {
        public uint pFiles;
        public int x;
        public int y;
        public int fNC;
        public int fWide;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalUnlock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr memory);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint DragQueryFileW(
        IntPtr drop,
        uint fileIndex,
        StringBuilder fileName,
        uint characterCount
    );

    public static string[] RoundTripDropFiles(string[] paths)
    {
        string payload = string.Join("\0", paths) + "\0\0";
        byte[] encoded = Encoding.Unicode.GetBytes(payload);
        int headerSize = Marshal.SizeOf<DropFiles>();
        IntPtr memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, (UIntPtr)(headerSize + encoded.Length));
        if (memory == IntPtr.Zero)
            throw new InvalidOperationException("GlobalAlloc failed: " + Marshal.GetLastWin32Error());

        try
        {
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero)
                throw new InvalidOperationException("GlobalLock failed: " + Marshal.GetLastWin32Error());

            try
            {
                DropFiles header = new DropFiles
                {
                    pFiles = (uint)headerSize,
                    fWide = 1,
                };
                Marshal.StructureToPtr(header, pointer, false);
                Marshal.Copy(encoded, 0, IntPtr.Add(pointer, headerSize), encoded.Length);
            }
            finally
            {
                GlobalUnlock(memory);
            }

            uint count = DragQueryFileW(memory, UInt32.MaxValue, null, 0);
            string[] result = new string[count];
            for (uint index = 0; index < count; index++)
            {
                uint length = DragQueryFileW(memory, index, null, 0);
                StringBuilder buffer = new StringBuilder((int)length + 1);
                uint copied = DragQueryFileW(memory, index, buffer, (uint)buffer.Capacity);
                if (copied != length)
                    throw new InvalidOperationException("DragQueryFileW returned an unexpected length");
                result[index] = buffer.ToString();
            }
            return result;
        }
        finally
        {
            GlobalFree(memory);
        }
    }

    public static bool ReadOnlyDeleteIsRejected(string path)
    {
        FileInfo file = new FileInfo(path);
        file.IsReadOnly = true;
        try
        {
            File.Delete(path);
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return true;
        }
        finally
        {
            file.Refresh();
            if (file.Exists)
                file.IsReadOnly = false;
        }
    }

    public static bool SharedDeleteIsRejected(string path)
    {
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            try
            {
                File.Delete(path);
                return false;
            }
            catch (IOException)
            {
                return true;
            }
        }
    }
}
"@

$dropPaths = @(
    "C:\素材\朱红肖像研究.jpg",
    "D:\视觉档案\场景参考"
)
$roundTrip = [VistashWindowsPlatformSpike]::RoundTripDropFiles($dropPaths)
if ($roundTrip.Count -ne $dropPaths.Count) {
    throw "DragQueryFileW 条目数量不一致"
}
for ($index = 0; $index -lt $dropPaths.Count; $index += 1) {
    if ($roundTrip[$index] -cne $dropPaths[$index]) {
        throw "DragQueryFileW 路径往返不一致：$($roundTrip[$index])"
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vistash-platform-spike-" + [guid]::NewGuid().ToString("N"))
$resolvedRoot = [System.IO.Path]::GetFullPath($tempRoot)
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $resolvedRoot.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "临时目录不在系统临时根内：$resolvedRoot"
}

[System.IO.Directory]::CreateDirectory($resolvedRoot) | Out-Null
try {
    $readOnlyPath = Join-Path $resolvedRoot "readonly-preview.txt"
    [System.IO.File]::WriteAllText($readOnlyPath, "Vistash preview copy", $utf8NoBom)
    if (-not [VistashWindowsPlatformSpike]::ReadOnlyDeleteIsRejected($readOnlyPath)) {
        throw "只读文件删除没有按预期被拒绝"
    }
    [System.IO.File]::Delete($readOnlyPath)

    $sharedPath = Join-Path $resolvedRoot "open-preview.txt"
    [System.IO.File]::WriteAllText($sharedPath, "Vistash open preview", $utf8NoBom)
    if (-not [VistashWindowsPlatformSpike]::SharedDeleteIsRejected($sharedPath)) {
        throw "被占用文件删除没有按预期被拒绝"
    }
    [System.IO.File]::Delete($sharedPath)

    Add-Type -AssemblyName System.Drawing
    $pngPath = Join-Path $resolvedRoot "clipboard-bitmap.png"
    $bitmap = [System.Drawing.Bitmap]::new(2, 2)
    try {
        $bitmap.SetPixel(0, 0, [System.Drawing.Color]::FromArgb(255, 232, 102, 74))
        $bitmap.SetPixel(1, 0, [System.Drawing.Color]::FromArgb(180, 17, 19, 19))
        $bitmap.SetPixel(0, 1, [System.Drawing.Color]::FromArgb(255, 235, 231, 221))
        $bitmap.SetPixel(1, 1, [System.Drawing.Color]::Transparent)
        $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
    $pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
    $pngSignature = @(137, 80, 78, 71, 13, 10, 26, 10)
    for ($index = 0; $index -lt $pngSignature.Count; $index += 1) {
        if ($pngBytes[$index] -ne $pngSignature[$index]) {
            throw "位图未编码为有效 PNG"
        }
    }
}
finally {
    if ([System.IO.Directory]::Exists($resolvedRoot)) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}

Write-Output "Windows 平台最小验证通过：CF_HDROP 路径、只读删除、占用删除、位图 PNG 编码。"
