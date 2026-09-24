extends Node2D


func _draw() -> void:
	draw_rect(Rect2(0, 0, 640, 360), Color(0.08, 0.2, 0.85))
	draw_circle(Vector2(320, 180), 70.0, Color(0.95, 0.12, 0.08))


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	var mode := "daily"
	if not args.is_empty():
		mode = args[0]
	if mode not in ["daily", "foreground", "switched", "locked"]:
		push_error("Unknown probe mode: " + mode)
		get_tree().quit(2)
		return

	queue_redraw()
	for frame in range(3):
		await get_tree().process_frame
	await RenderingServer.frame_post_draw

	var adapter := RenderingServer.get_video_adapter_name()
	var image := get_viewport().get_texture().get_image()
	var output := "C:/ci-runners/graphics-probe/" + mode
	var rendered := not image.is_empty() and image.get_width() == 640 and image.get_height() == 360
	var colored := false
	if rendered:
		var center := image.get_pixel(320, 180)
		var corner := image.get_pixel(10, 10)
		colored = center.r > 0.7 and center.b < 0.3 and corner.b > 0.6
	var saved := image.save_png(output + ".png") == OK
	var passed := rendered and colored and saved and adapter.contains("RTX 4080")
	var report := {
		"mode": mode,
		"adapter": adapter,
		"width": image.get_width(),
		"height": image.get_height(),
		"colored": colored,
		"saved": saved,
		"passed": passed,
	}
	var file := FileAccess.open(output + ".json", FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(report))
		file.close()
	print("AURA_CI_GRAPHICS_PROBE " + JSON.stringify(report))
	get_tree().quit(0 if passed else 2)
