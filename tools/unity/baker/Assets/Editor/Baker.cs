using UnityEngine;
using UnityEditor;
using UnityEngine.Playables;
using UnityEngine.Animations;
using System.IO;
using System.Collections.Generic;
using UnityGLTF;
using UnityGLTF.Timeline;

public static class Baker
{
    public static void Bake()
    {
        string fbx = "Assets/Chars/Characters.fbx";
        var src = AssetDatabase.LoadAssetAtPath<GameObject>(fbx);
        if (src == null)
        {
            Debug.LogError("Baker: could not load " + fbx);
            EditorApplication.Exit(1);
            return;
        }

        var inst = Object.Instantiate(src);
        var animator = inst.GetComponent<Animator>();
        if (animator == null) animator = inst.AddComponent<Animator>();

        foreach (var a in AssetDatabase.LoadAllAssetsAtPath(fbx))
        {
            if (a is Avatar av) animator.avatar = av;
        }
        animator.applyRootMotion = false;
        animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;

        string outDir = Path.GetFullPath("BakedOut");
        Directory.CreateDirectory(outDir);

        // ---- 1) export the static skinned character once (no animation) ----
        try
        {
            var exporter = new GLTFSceneExporter(new Transform[] { inst.transform }, new ExportContext());
            string basePath = Path.Combine(outDir, "characters-base.glb");
            using (var fs = new FileStream(basePath, FileMode.Create, FileAccess.Write))
            {
                exporter.SaveGLBToStream(fs, "characters-base");
            }
            Debug.Log("Baker: wrote " + basePath);
        }
        catch (System.Exception e)
        {
            Debug.LogError("Baker: base export failed: " + e);
        }

        // ---- 2) bake each clip ----
        string bakeFilter = System.Environment.GetEnvironmentVariable("BAKE_FILTER") ?? "";
        string bakeSuffix = System.Environment.GetEnvironmentVariable("BAKE_SUFFIX") ?? "";

        var guids = AssetDatabase.FindAssets("t:AnimationClip", new[] { "Assets/Clips" });
        Debug.Log("Baker: found " + guids.Length + " AnimationClip assets");

        int baked = 0;
        foreach (string guid in guids)
        {
            string clipPath = AssetDatabase.GUIDToAssetPath(guid);

            if (!string.IsNullOrEmpty(bakeFilter) && clipPath.IndexOf(bakeFilter, System.StringComparison.Ordinal) < 0)
            {
                continue;
            }

            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
            if (clip == null) continue;

            PlayableGraph graph = default;
            try
            {
                graph = PlayableGraph.Create("bake_" + clip.name);
                graph.SetTimeUpdateMode(DirectorUpdateMode.Manual);
                var output = AnimationPlayableOutput.Create(graph, "o", animator);
                var playable = AnimationClipPlayable.Create(graph, clip);
                playable.SetApplyFootIK(false);
                output.SetSourcePlayable(playable);
                graph.Play();

                float fps = 30f;
                int frames = Mathf.Max(2, Mathf.CeilToInt(clip.length * fps) + 1);

                var recorder = new GLTFRecorder(inst.transform, true, false, false);
                recorder.AnimationName = clip.name;

                // prime frame 0
                playable.SetTime(0);
                graph.Evaluate(0);
                recorder.StartRecording(0);

                for (int f = 1; f < frames; f++)
                {
                    float t = Mathf.Min(f / fps, clip.length);
                    playable.SetTime(t);
                    graph.Evaluate(1f / fps);
                    recorder.UpdateRecording(t);
                }

                string safe = clip.name.Replace(" ", "_").Replace("|", "_").Replace("/", "_") + bakeSuffix;
                string outPath = Path.Combine(outDir, safe + ".glb");
                using (var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
                {
                    recorder.EndRecording(fs, safe);
                }
                Debug.Log("Baker: baked " + clip.name + " (" + clip.length.ToString("F3") + "s, " + frames + " frames) -> " + outPath);
                baked++;
            }
            catch (System.Exception e)
            {
                Debug.LogError("Baker: failed to bake clip " + clip.name + ": " + e);
            }
            finally
            {
                if (graph.IsValid()) graph.Destroy();
            }
        }

        Debug.Log("Baker: done. Baked " + baked + " / " + guids.Length + " clips.");
        EditorApplication.Exit(0);
    }
}
